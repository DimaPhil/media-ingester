import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobRecord, Lease } from '@media-ingest/sdk';
import { LeaseLostError } from '@media-ingest/sdk';
import { applyMigrations, PostgresAuthStore, PostgresJobRepository } from '../src/postgres.js';
import { NodeFiles } from '../src/files.js';
import { PostgresUploadRetention } from '../src/upload-retention.js';
import { PostgresJobRetention } from '../src/job-retention.js';
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
  let workRoot: string;
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
    await sql`TRUNCATE media_v1.jobs, media_v1.auth_entries, media_v1.upload_retention, media_v1.processed_media`;
    workRoot = await mkdtemp(join(tmpdir(), 'media-retention-'));
  });
  afterAll(async () => {
    if (!verified) return sql.end();
    for (const owner of owners) {
      await sql`DELETE FROM media_v1.jobs WHERE owner_id=${owner}`;
      await sql`DELETE FROM media_v1.processed_media WHERE owner_id=${owner}`;
    }
    await sql`DELETE FROM media_v1.auth_entries WHERE key LIKE ${prefix + '%'}`;
    await sql`DELETE FROM media_v1.upload_retention WHERE owner_id LIKE ${prefix + '%'}`;
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
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

  it('backfills old completed outputs before enabling terminal expiry', async () => {
    const legacy = job();
    const result = {
      kind: 'transcription',
      provider: 'openai',
      model: 'fixture',
      text: 'Retain this output',
      segments: [],
      timeRanges: [],
      detectedLanguage: 'en',
    };
    await repository.enqueue(legacy);
    const completed = {
      ...legacy,
      status: 'completed',
      result,
      sourceFingerprint: 'legacy-content',
    };
    await sql`UPDATE media_v1.jobs SET status='completed',data=${sql.json(completed)}
      WHERE id=${legacy.id}`;
    // Exercise the real upgrade from migration 002 in this verified disposable database.
    await sql`DROP TABLE media_v1.processed_media`;
    await sql`ALTER TABLE media_v1.jobs DROP COLUMN expires_at`;
    await sql`DELETE FROM media_v1.migrations WHERE version=3`;
    await applyMigrations(sql);
    expect(await repository.getResult(legacy.ownerId, legacy.id)).toMatchObject({
      mediaId: 'legacy-content',
      media: null,
      result,
    });
    const [row] = await sql<{ expired: boolean }[]>`SELECT expires_at < now() AS expired
      FROM media_v1.jobs WHERE id=${legacy.id}`;
    expect(row?.expired).toBe(true);
    await sql`DELETE FROM media_v1.jobs WHERE id=${legacy.id}`;
    expect(await repository.getResult(legacy.ownerId, legacy.id)).not.toBeNull();
  });

  it('expires only terminal execution records and preserves results and failed inputs', async () => {
    const files = new NodeFiles({ workRoot });
    const uploads = new PostgresUploadRetention(sql, files);
    const coordinatedFiles = new NodeFiles({ workRoot, uploadLifecycle: uploads });
    const jobs = new PostgresJobRepository(sql, undefined, uploads);
    const retention = new PostgresJobRetention(sql, uploads);
    const original = job();
    const upload = await coordinatedFiles.upload(
      original.ownerId,
      'recording.wav',
      Buffer.from('keep failed input').toString('base64'),
    );
    original.request.source = upload.source;
    await jobs.enqueue(original);
    const lease = (await jobs.claim(0, 60_000))!;
    expect(lease.job.id).toBe(original.id);
    const chunk = { text: 'Saved words', segments: [], timeRanges: [], detectedLanguage: 'en' };
    const result = {
      ...chunk,
      kind: 'transcription' as const,
      provider: 'openai' as const,
      model: 'fixture',
    };
    await jobs.savePlan(
      original.id,
      lease.token,
      [{ index: 0, startMs: 0, endMs: 1000 }],
      'content',
      0,
    );
    await jobs.saveChunk(original.id, lease.token, 0, chunk, 0);
    await jobs.complete(original.id, lease.token, result, 0, {
      source: {
        source: upload.source,
        fileName: 'recording.wav',
        mimeType: 'audio/wav',
        metadata: { mediaId: upload.source.uri },
      },
      inspection: { durationMs: 1000, hasAudio: true, hasVideo: false },
    });
    const failed = { ...job(), ownerId: original.ownerId };
    failed.request.source = upload.source;
    await jobs.enqueue(failed);
    const failedLease = (await jobs.claim(0, 60_000))!;
    expect(failedLease.job.id).toBe(failed.id);
    await jobs.fail(
      failed.id,
      failedLease.token,
      { code: 'fixture', message: 'Failed', retryable: true },
      0,
    );
    expect(await uploads.drain()).toBe(0);
    const running = await jobs.enqueue(job());
    const runningLease = (await jobs.claim(0, 60_000))!;
    expect(runningLease.job.id).toBe(running.id);
    const queued = await jobs.enqueue(job());
    await sql`UPDATE media_v1.jobs SET expires_at=clock_timestamp()-interval '1 second'
      WHERE id IN (${original.id},${failed.id},${running.id},${queued.id})`;
    const counts = await Promise.all([retention.drain(), retention.drain()]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(await jobs.get(original.ownerId, original.id)).toBeNull();
    expect(await jobs.get(failed.ownerId, failed.id)).toBeNull();
    expect((await jobs.get(running.ownerId, running.id))?.status).toBe('running');
    expect((await jobs.get(queued.ownerId, queued.id))?.status).toBe('queued');
    expect(await jobs.getResult(original.ownerId, original.id)).toMatchObject({
      mediaId: upload.source.uri,
      result,
      media: { source: { fileName: 'recording.wav' }, inspection: { durationMs: 1000 } },
    });
    expect(await jobs.getResult('different-owner', original.id)).toBeNull();
    expect((await jobs.history(original.ownerId, { limit: 20 })).items).toHaveLength(1);
    expect(await uploads.drain()).toBe(0);
    expect(
      await coordinatedFiles.uploadMetadata(original.ownerId, upload.source.uri),
    ).toBeDefined();
    await sql`DELETE FROM media_v1.jobs WHERE id IN (${running.id},${queued.id})`;
  });

  it('paginates durable history by owner and media ID without returning full outputs', async () => {
    const first = job();
    const inputs = [first, { ...job(), ownerId: first.ownerId }, job()];
    for (const [index, input] of inputs.entries()) {
      await repository.enqueue(input);
      const lease = (await repository.claim(0, 60_000))!;
      expect(lease.job.id).toBe(input.id);
      const chunk = {
        text: (index === 0 ? 'x' : '😀').repeat(400),
        segments: [],
        timeRanges: [],
        detectedLanguage: null,
      };
      await repository.savePlan(
        input.id,
        lease.token,
        [{ index: 0, startMs: 0, endMs: 1 }],
        'shared-content',
        0,
      );
      await repository.saveChunk(input.id, lease.token, 0, chunk, 0);
      await repository.complete(
        input.id,
        lease.token,
        {
          ...chunk,
          kind: 'transcription',
          provider: 'openai',
          model: 'fixture',
        },
        0,
      );
    }
    const firstPage = await repository.history(first.ownerId, {
      limit: 1,
      mediaId: 'shared-content',
    });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0]?.preview).toHaveLength(240);
    expect(firstPage.items[0]).not.toHaveProperty('result');
    const secondPage = await repository.history(first.ownerId, {
      limit: 1,
      before: firstPage.nextBefore!,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    expect(secondPage.nextBefore).toBeNull();
    expect(await repository.history(first.ownerId, { limit: 20, before: inputs[2]!.id })).toEqual({
      items: [],
      nextBefore: null,
    });
    expect(
      (await repository.history(first.ownerId, { limit: 20, mediaId: 'absent' })).items,
    ).toEqual([]);
    await sql`UPDATE media_v1.jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${first.id}`;
    await sql`DELETE FROM media_v1.processed_media WHERE id=${first.id}`;
    const uploads = new PostgresUploadRetention(sql, new NodeFiles({ workRoot }));
    await new PostgresJobRetention(sql, uploads).drain();
    expect(await repository.get(first.ownerId, first.id)).not.toBeNull();
  });

  it('finds owner-scoped results newest first and completes fenced jobs from them without a new history record', async () => {
    const owner = job();
    const other = job();
    const result = (text: string) => ({
      kind: 'transcription' as const,
      provider: 'openai' as const,
      model: 'fixture',
      text,
      segments: [],
      timeRanges: [],
      detectedLanguage: null,
    });
    const media = {
      source: {
        source: owner.request.source,
        fileName: 'clip.mp3',
        metadata: { mediaId: `vid-${owner.ownerId}` },
      },
      inspection: { durationMs: 1, hasAudio: true, hasVideo: false },
    };
    const inputs = [owner, { ...job(), ownerId: owner.ownerId }, other];
    for (const [index, input] of inputs.entries()) {
      await repository.enqueue(input);
      const lease = (await repository.claim(0, 60_000))!;
      expect(lease.job.id).toBe(input.id);
      const chunk = result(`run ${index}`);
      await repository.savePlan(
        input.id,
        lease.token,
        [{ index: 0, startMs: 0, endMs: 1 }],
        `reuse-${owner.ownerId}`,
        0,
      );
      await repository.saveChunk(input.id, lease.token, 0, chunk, 0);
      await repository.complete(input.id, lease.token, chunk, 0, media);
    }
    const byContent = await repository.findResults(
      owner.ownerId,
      { fingerprint: `reuse-${owner.ownerId}` },
      10,
    );
    expect(byContent.map((record) => record.id)).toEqual([inputs[1]!.id, owner.id]);
    const bySite = await repository.findResults(
      owner.ownerId,
      { mediaId: `vid-${owner.ownerId}` },
      1,
    );
    expect(bySite.map((record) => record.id)).toEqual([inputs[1]!.id]);
    expect(await repository.findResults('absent', { mediaId: `vid-${owner.ownerId}` }, 10)).toEqual(
      [],
    );

    let now = 1000;
    const workers = new PostgresJobRepository(sql, () => now);
    const reuse = { ...job(), ownerId: owner.ownerId };
    await workers.enqueue(reuse);
    const stale = (await workers.claim(now, 100))!;
    expect(stale.job.id).toBe(reuse.id);
    const [otherRecord] = await repository.findResults(
      other.ownerId,
      { fingerprint: `reuse-${owner.ownerId}` },
      1,
    );
    await expect(
      workers.completeFromCache(reuse.id, stale.token, otherRecord!, now),
    ).rejects.toMatchObject({ code: 'not_found' });
    now = 1101;
    const current = (await workers.claim(now, 100))!;
    await expect(
      workers.completeFromCache(reuse.id, stale.token, bySite[0]!, now),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await workers.completeFromCache(reuse.id, current.token, bySite[0]!, now);
    expect(await workers.get(owner.ownerId, reuse.id)).toMatchObject({
      status: 'completed',
      cachedFrom: inputs[1]!.id,
      result: result('run 1'),
      leaseToken: null,
    });
    expect((await repository.history(owner.ownerId, { limit: 20 })).items).toHaveLength(2);
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
    // JSONB may return chunk properties in a different order from the submitted plan.
    await repository.savePlan(pending.id, retry.token, plan, 'sha256:original', 2007);
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

  describe('uploaded media retention', () => {
    const encoded = Buffer.from('original bytes').toString('base64');
    const result = {
      kind: 'transcription' as const,
      provider: 'openai' as const,
      model: 'test',
      text: 'saved transcript',
      detectedLanguage: 'en',
      segments: [],
      timeRanges: [],
    };

    async function fixture() {
      const disk = new NodeFiles({ workRoot });
      const retention = new PostgresUploadRetention(sql, disk);
      const files = new NodeFiles({ workRoot, uploadLifecycle: retention });
      const first = job('initial');
      const { source } = await files.upload(first.ownerId, 'clip.mp3', encoded);
      first.request.source = source;
      let now = 1000;
      const jobs = new PostgresJobRepository(sql, () => now, retention);
      const path = (await disk.uploadMetadata(first.ownerId, source.uri)).path;
      const claim = async () => {
        const lease = await jobs.claim(now, 100);
        if (!lease) throw new Error('Expected queued upload job');
        return lease;
      };
      const complete = async (lease: Lease) => {
        await jobs.savePlan(
          lease.job.id,
          lease.token,
          [{ index: 0, startMs: 0, endMs: 1 }],
          'source',
          now,
        );
        await jobs.saveChunk(lease.job.id, lease.token, 0, result, now);
        await jobs.complete(lease.job.id, lease.token, result, now);
      };
      return {
        files,
        disk,
        retention,
        first,
        jobs,
        path,
        claim,
        complete,
        expire: () => {
          now += 101;
        },
      };
    }

    it('keeps shared bytes through queue, lease takeover and failed retry, then deletes only the completed input', async () => {
      const { disk, retention, first, jobs, path, claim, complete, expire } = await fixture();
      await jobs.enqueue(first);
      const earlier = await claim();
      const next = await jobs.enqueue({ ...first, id: randomUUID(), idempotencyKey: 'next' });
      await complete(earlier);
      await retention.drain();
      expect(await readFile(path, 'utf8')).toBe('original bytes');

      const stale = await claim();
      expect(stale.job.id).toBe(next.id);
      expire();
      const current = await claim();
      await expect(jobs.complete(next.id, stale.token, result, 1101)).rejects.toBeInstanceOf(
        LeaseLostError,
      );
      await retention.drain();
      expect(await readFile(path, 'utf8')).toBe('original bytes');
      await jobs.fail(
        next.id,
        current.token,
        { code: 'temporary', message: 'retry', retryable: true },
        1101,
      );
      await retention.drain();
      expect(await readFile(path, 'utf8')).toBe('original bytes');

      await jobs.retry(first.ownerId, next.id, 1101);
      await complete(await claim());
      const restarted = new PostgresUploadRetention(sql, disk);
      await Promise.all([retention.drain(), restarted.drain()]);
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await jobs.get(first.ownerId, first.id))?.result).toEqual(result);
      expect((await jobs.get(first.ownerId, next.id))?.result).toEqual(result);
      expect((await jobs.enqueue({ ...first, id: randomUUID() })).id).toBe(first.id);
      await expect(
        jobs.enqueue({ ...first, id: randomUUID(), idempotencyKey: 'missing' }),
      ).rejects.toThrow();
    });

    it('deletes the upload after the last job completes from a retained result', async () => {
      const { retention, first, jobs, path, claim, complete } = await fixture();
      await jobs.enqueue(first);
      // Fixture jobs share createdAt, so claim the first one before queueing the next.
      const original = await claim();
      const reused = await jobs.enqueue({ ...first, id: randomUUID(), idempotencyKey: 'reused' });
      await complete(original);
      await retention.drain();
      expect(await readFile(path, 'utf8')).toBe('original bytes');
      const lease = await claim();
      expect(lease.job.id).toBe(reused.id);
      const [cached] = await jobs.findResults(first.ownerId, { fingerprint: 'source' }, 1);
      await jobs.completeFromCache(reused.id, lease.token, cached!, 1000);
      await retention.drain();
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await jobs.get(first.ownerId, reused.id))?.cachedFrom).toBe(first.id);
    });

    it('protects an identical reupload between submission and completion, and leaves unrelated files intact', async () => {
      const { files, disk, retention, first, jobs, path, claim, complete } = await fixture();
      const other = job();
      const untouched = await files.upload(other.ownerId, 'clip.mp3', encoded);
      const untouchedPath = (await disk.uploadMetadata(other.ownerId, untouched.source.uri)).path;
      const old = job();
      old.request.source = (await disk.upload(old.ownerId, 'legacy.mp3', encoded)).source;
      await repository.enqueue(old);
      const historicLease = (await repository.claim(1000, 60_000))!;
      await repository.savePlan(old.id, historicLease.token, [], 'source', 1000);
      await repository.complete(old.id, historicLease.token, result, 1000);
      const historicPath = (await disk.uploadMetadata(old.ownerId, old.request.source.uri)).path;

      await jobs.enqueue(first);
      const initialLease = await claim();
      const fresh = await files.upload(first.ownerId, 'clip.mp3', encoded);
      expect(fresh.source).toEqual(first.request.source);
      await complete(initialLease);
      await retention.drain();
      expect(await readFile(path, 'utf8')).toBe('original bytes');
      await jobs.enqueue({ ...first, id: randomUUID(), idempotencyKey: 'fresh' });
      await complete(await claim());
      await retention.drain();
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(untouchedPath, 'utf8')).toBe('original bytes');
      expect(await readFile(historicPath, 'utf8')).toBe('original bytes');
    });

    it('serializes deletion with an overlapping submission and rolls back the missing input', async () => {
      const { disk, first, jobs, path, claim, complete } = await fixture();
      await jobs.enqueue(first);
      await complete(await claim());
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const removeUpload = vi.fn(async (ownerId: string, id: string) => {
        await gate;
        await disk.removeUpload(ownerId, id);
      });
      const janitor = new PostgresUploadRetention(sql, {
        uploadMetadata: disk.uploadMetadata.bind(disk),
        removeUpload,
      });
      const next = { ...first, id: randomUUID(), idempotencyKey: 'overlap' };
      const sweep = janitor.drain();
      let submission: Promise<JobRecord | Error> | undefined;
      try {
        await vi.waitFor(() => expect(removeUpload).toHaveBeenCalledOnce());
        submission = jobs.enqueue(next).catch((error: Error) => error);
        await vi.waitFor(async () => {
          // Observe the wait for this exact two-key upload lock on another connection.
          const [row] = await sql<{ waiting: boolean }[]>`SELECT EXISTS (
            SELECT FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND classid = hashtext(${first.ownerId})::oid
            AND objid = hashtext(${first.request.source.uri})::oid AND objsubid = 2
          ) AS waiting`;
          expect(row!.waiting).toBe(true);
        });
        expect(await readFile(path, 'utf8')).toBe('original bytes');
      } finally {
        release();
        await sweep;
        await submission;
      }
      expect(await submission).toMatchObject({ code: 'not_found' });
      expect(await jobs.get(first.ownerId, next.id)).toBeNull();
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('retries filesystem cleanup after restart without changing the completed result', async () => {
      const { disk, first, jobs, path, claim, complete } = await fixture();
      await jobs.enqueue(first);
      await complete(await claim());
      const broken = new PostgresUploadRetention(sql, {
        uploadMetadata: disk.uploadMetadata.bind(disk),
        removeUpload: async () => {
          throw new Error('Volume unavailable');
        },
      });
      await expect(broken.drain()).rejects.toThrow();
      expect((await jobs.get(first.ownerId, first.id))?.result).toEqual(result);
      expect(await readFile(path, 'utf8')).toBe('original bytes');
      await sql`UPDATE media_v1.upload_retention SET next_attempt_at = now() WHERE owner_id = ${first.ownerId}`;
      const restarted = new PostgresUploadRetention(sql, disk);
      expect(await restarted.drain()).toBe(1);
      expect(await restarted.drain()).toBe(0);
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
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
