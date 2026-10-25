import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobRecord } from '@media-ingest/sdk';
import { LeaseLostError } from '@media-ingest/sdk';
import { applyMigrations, PostgresAuthStore, PostgresJobRepository } from '../src/postgres.js';
import { requireDisposableDatabase } from '../../../test/support/database.js';

const url = process.env.TEST_DATABASE_URL;
if (url) requireDisposableDatabase(url);
describe.skipIf(!url)('PostgreSQL persistence integration', () => {
  const sql = postgres(url ?? 'postgres://localhost/media_ingest_test', { max: 8 });
  const repository = new PostgresJobRepository(sql);
  const prefix = `test-${randomUUID()}`;
  const owners: string[] = [];
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
    // TEST_DATABASE_URL must point to a disposable database. Queue-wide claims require isolation.
    await Promise.all([applyMigrations(sql), applyMigrations(sql)]);
    await sql`TRUNCATE media_v1.jobs, media_v1.auth_entries`;
  });
  afterAll(async () => {
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
    const pending = await repository.enqueue(job());
    const claims = await Promise.all([repository.claim(1000, 100), repository.claim(1000, 100)]);
    const lease = claims.find((value) => value !== null)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(lease.job.id).toBe(pending.id);
    await repository.heartbeat(pending.id, lease.token, 1050, 100);
    expect(await repository.claim(1100, 100)).toBeNull();
    const replacement = (await repository.claim(1150, 100))!;
    expect(replacement.token).not.toBe(lease.token);
    expect(replacement.job.attempt).toBe(2);
    await expect(repository.heartbeat(pending.id, lease.token, 1151, 100)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await expect(
      repository.fail(
        pending.id,
        lease.token,
        { code: 'stale', message: 'stale', retryable: true },
        1151,
      ),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await repository.fail(
      pending.id,
      replacement.token,
      { code: 'test', message: 'test', retryable: true },
      1151,
    );
  });

  it('retains completed chunks through failure, retry and finalization', async () => {
    const pending = await repository.enqueue(job());
    const lease = (await repository.claim(2000, 100))!;
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
    const retry = (await repository.claim(2006, 100))!;
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
