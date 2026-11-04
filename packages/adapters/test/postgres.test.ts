import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '@media-ingest/sdk';
import { LeaseLostError } from '@media-ingest/sdk';
import { applyMigrations, PostgresAuthStore, PostgresJobRepository } from '../src/postgres.js';
import {
  requireDisposableDatabase,
  verifyDisposableDatabase,
} from '../../../test/support/database.js';

const url = process.env.TEST_DATABASE_URL;
if (url) requireDisposableDatabase(url);
describe.skipIf(!url)('PostgreSQL persistence integration', () => {
  const sql = postgres(url ?? 'postgres://localhost/media_ingest_test', { max: 8 });
  const repository = new PostgresJobRepository(sql);
  const prefix = `test-${randomUUID()}`;
  const owners: string[] = [];
  let verified = false;
  function job(idempotencyKey?: string): JobRecord {
    const ownerId = `${prefix}-${randomUUID()}`;
    owners.push(ownerId);
    return {
      id: randomUUID(),
      ownerId,
      idempotencyKey,
      requestHash: 'request-a',
      status: 'queued',
      request: {
        kind: 'transcription',
        source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
        provider: 'openai',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      completedChunks: 0,
      totalChunks: 0,
      attempt: 0,
      result: null,
      error: null,
      plan: null,
      chunks: {},
      leaseToken: null,
      leaseExpiresAt: null,
      sourceFingerprint: null,
    };
  }
  beforeAll(async () => {
    await verifyDisposableDatabase(sql, url!);
    verified = true;
    // TEST_DATABASE_URL must point to a disposable database. Queue-wide claims require isolation.
    await Promise.all([applyMigrations(sql), applyMigrations(sql)]);
    await sql`TRUNCATE media_v1.jobs, media_v1.auth_entries`;
  });
  afterAll(async () => {
    if (!verified) return sql.end();
    for (const owner of owners) await sql`DELETE FROM media_v1.jobs WHERE owner_id=${owner}`;
    await sql`DELETE FROM media_v1.auth_entries WHERE key LIKE ${prefix + '%'}`;
    await sql.end();
  });

  it('atomically deduplicates concurrent submissions and rejects mismatched requests', async () => {
    const first = job('same-key');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repository.enqueue({ ...first, id: randomUUID() })),
    );
    expect(new Set(results.map((value) => value.id)).size).toBe(1);
    await expect(repository.enqueue({ ...first, requestHash: 'request-b' })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    expect(await repository.get('different-owner', results[0]!.id)).toBeNull();
    expect(await repository.list(first.ownerId, { limit: 20 })).toHaveLength(1);
    expect(await repository.list(first.ownerId, { limit: 20, status: 'completed' })).toHaveLength(
      0,
    );
    await sql`DELETE FROM media_v1.jobs WHERE owner_id=${first.ownerId}`;
  });

  it('claims once and fences an expired worker after another worker reclaims', async () => {
    let now = 1000;
    const workers = new PostgresJobRepository(sql, () => now);
    const pending = await repository.enqueue(job());
    const claims = await Promise.all([workers.claim(now, 100), workers.claim(now, 100)]);
    const lease = claims.find((value) => value !== null)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(lease.job.id).toBe(pending.id);
    now = 1050;
    await workers.heartbeat(pending.id, lease.token, now, 100);
    now = 1100;
    expect(await workers.claim(now, 100)).toBeNull();
    now = 1150;
    const replacement = (await workers.claim(now, 100))!;
    expect(replacement.token).not.toBe(lease.token);
    expect(replacement.job.attempt).toBe(2);
    await expect(workers.heartbeat(pending.id, lease.token, now, 100)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await expect(
      workers.fail(
        pending.id,
        lease.token,
        { code: 'stale', message: 'stale', retryable: true },
        1151,
      ),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await workers.fail(
      pending.id,
      replacement.token,
      { code: 'test', message: 'test', retryable: true },
      1151,
    );
  });

  it.each(['heartbeat', 'checkpoint'] as const)(
    'rejects a %s delayed past expiry by a row lock',
    async (action) => {
      let now = 4000;
      const workers = new PostgresJobRepository(sql, () => now);
      const pending = await workers.enqueue(job());
      const lease = (await workers.claim(now, 100))!;
      let outcome: Promise<void | Error>;
      await sql.begin(async (blocker) => {
        const [row] = await blocker<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid FROM media_v1.jobs WHERE id=${pending.id} FOR UPDATE`;
        const request =
          action === 'heartbeat'
            ? workers.heartbeat(pending.id, lease.token, now, 100)
            : workers.savePlan(
                pending.id,
                lease.token,
                [{ index: 0, startMs: 0, endMs: 1 }],
                'bytes',
                now,
              );
        outcome = request.catch((error: Error) => error);
        await vi.waitFor(async () => {
          const [state] = await sql<{ blocked: boolean }[]>`SELECT EXISTS(
          SELECT FROM pg_stat_activity WHERE ${row!.pid} = ANY(pg_blocking_pids(pid))
        ) AS blocked`;
          expect(state!.blocked).toBe(true);
        });
        // The request already reached PostgreSQL. Advance past its lease before COMMIT releases the lock.
        now = 4120;
      });
      expect(await outcome!).toBeInstanceOf(LeaseLostError);
      const expired = await workers.get(pending.ownerId, pending.id);
      expect(expired?.leaseExpiresAt).toBe(4100);
      expect(expired?.plan).toBeNull();
      const fresh = (await workers.claim(now, 100))!;
      expect(fresh.token).not.toBe(lease.token);
      await workers.fail(
        pending.id,
        fresh.token,
        { code: 'test', message: 'test', retryable: true },
        now,
      );
    },
  );

  it('retains completed chunks through failure, retry and finalization', async () => {
    const pending = await repository.enqueue(job());
    const lease = (await repository.claim(2000, 60_000))!;
    const plan = [
      { index: 0, startMs: 0, endMs: 1000 },
      { index: 1, startMs: 1000, endMs: 2000 },
    ];
    const output = { text: 'hello', segments: [], timeRanges: [], detectedLanguage: 'en' };
    await repository.savePlan(pending.id, lease.token, plan, 'sha256:original', 2001);
    await repository.saveChunk(pending.id, lease.token, 0, output, 2002);
    await repository.saveChunk(pending.id, lease.token, 0, output, 2003);
    expect((await repository.get(pending.ownerId, pending.id))?.completedChunks).toBe(1);
    await repository.fail(
      pending.id,
      lease.token,
      { code: 'temporary', message: 'temporary', retryable: true },
      2004,
    );
    await expect(repository.retry('other', pending.id, 2005)).rejects.toMatchObject({
      code: 'not_found',
    });
    await repository.retry(pending.ownerId, pending.id, 2005);
    const retry = (await repository.claim(2006, 60_000))!;
    expect(retry.job.chunks['0']).toEqual(output);
    await expect(
      repository.savePlan(pending.id, retry.token, plan, 'sha256:changed', 2007),
    ).rejects.toMatchObject({ code: 'source_changed' });
    await expect(
      repository.savePlan(pending.id, retry.token, plan.slice(0, 1), 'sha256:original', 2007),
    ).rejects.toMatchObject({ code: 'plan_changed' });
    const result = {
      ...output,
      kind: 'transcription' as const,
      provider: 'openai' as const,
      model: 'test',
    };
    await expect(repository.complete(pending.id, retry.token, result, 2007)).rejects.toMatchObject({
      code: 'incomplete_job',
    });
    await expect(
      repository.saveChunk(pending.id, retry.token, 99, output, 2007),
    ).rejects.toMatchObject({ code: 'invalid_chunk' });
    await repository.saveChunk(pending.id, retry.token, 1, output, 2008);
    await repository.complete(pending.id, retry.token, result, 2009);
    expect((await repository.get(pending.ownerId, pending.id))?.result).toEqual(result);
    await expect(repository.retry(pending.ownerId, pending.id, 2010)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('consumes OAuth codes exactly once and enforces expiry', async () => {
    let now = 100;
    const auth = new PostgresAuthStore(sql, () => now);
    const key = `${prefix}-code`;
    await auth.put(key, { clientId: 'a' }, 200);
    expect(await auth.get(key)).toEqual({ clientId: 'a' });
    const values = await Promise.all([auth.take(key), auth.take(key)]);
    expect(values.filter(Boolean)).toEqual([{ clientId: 'a' }]);
    await auth.put(key, { clientId: 'b' }, 200);
    now = 200;
    expect(await auth.get(key)).toBeNull();
    expect(await auth.take(key)).toBeNull();
    await auth.put(key, { clientId: 'c' }, 300);
    await auth.delete(key);
    expect(await auth.get(key)).toBeNull();
    await auth.put(key, {}, 199);
    expect(await auth.prune()).toBe(1);
  });
});
