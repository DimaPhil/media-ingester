import type { JobRecord } from '@media-ingest/sdk';
import type { Sql, TransactionSql } from 'postgres';

interface UploadStorage {
  uploadMetadata(ownerId: string, id: string): Promise<unknown>;
  removeUpload(ownerId: string, id: string): Promise<void>;
}

async function lock(tx: TransactionSql, ownerId: string, id: string) {
  // Directory names are UUIDs. Case variants may alias on a case-insensitive filesystem.
  await tx`SELECT pg_advisory_xact_lock(hashtext(${ownerId}), hashtext(${id.toLowerCase()}))`;
}

function eligible(sql: Sql | TransactionSql) {
  // Failed jobs can be retried. Include jobs submitted before the retention migration.
  return sql`r.state = 'pending' AND r.next_attempt_at <= clock_timestamp() AND NOT EXISTS (
    SELECT 1 FROM media_v1.jobs j WHERE j.owner_id = r.owner_id AND j.status <> 'completed'
      AND j.data #>> '{request,source,kind}' = 'upload'
      AND lower(j.data #>> '{request,source,uri}') = r.upload_id
  )`;
}

/** Coordinates consumers of an owner-scoped upload across API processes sharing a volume. */
export class PostgresUploadRetention {
  constructor(
    private readonly sql: Sql,
    private readonly files: UploadStorage,
  ) {}

  async publish(ownerId: string, id: string, write: () => Promise<void>): Promise<void> {
    await this.sql.begin(async (tx) => {
      await lock(tx, ownerId, id);
      await write();
      await tx`INSERT INTO media_v1.upload_retention (owner_id, upload_id, state)
        VALUES (${ownerId}, ${id.toLowerCase()}, 'awaiting_submit')
        ON CONFLICT (owner_id, upload_id) DO UPDATE SET state = 'awaiting_submit'`;
    });
  }

  async read<T>(ownerId: string, id: string, action: () => Promise<T>): Promise<T> {
    const result = await this.sql.begin(async (tx) => {
      await lock(tx, ownerId, id);
      return { value: await action() };
    });
    return result.value;
  }

  /** Called in the enqueue transaction after checking idempotency. */
  async submitted(tx: TransactionSql, job: JobRecord, inserted: boolean): Promise<void> {
    const { source } = job.request;
    if (source.kind !== 'upload') return;
    const id = source.uri.toLowerCase();
    await lock(tx, job.ownerId, id);
    if (inserted) {
      // The insertion rolls back if the upload has already been removed.
      await this.files.uploadMetadata(job.ownerId, source.uri);
    } else {
      // CLI replays may have just republished the file for an already completed job.
      // Read its current status after locking rather than using the enqueue snapshot.
      await tx`UPDATE media_v1.upload_retention SET state = 'pending', next_attempt_at = now()
        WHERE owner_id = ${job.ownerId} AND upload_id = ${id} AND state = 'awaiting_submit'
        AND EXISTS (SELECT 1 FROM media_v1.jobs
          WHERE id = ${job.id} AND owner_id = ${job.ownerId} AND status = 'completed')`;
    }
    await tx`DELETE FROM media_v1.upload_retention WHERE owner_id = ${job.ownerId}
      AND upload_id = ${id} AND state = 'awaiting_submit'`;
  }

  /** The fenced result and its deletion intent must commit together. */
  async completed(tx: TransactionSql, job: JobRecord): Promise<void> {
    const { source } = job.request;
    if (source.kind !== 'upload') return;
    const id = source.uri.toLowerCase();
    await lock(tx, job.ownerId, id);
    // Preserve any fresh publication that hasn't been submitted yet.
    await tx`INSERT INTO media_v1.upload_retention (owner_id, upload_id, state)
      VALUES (${job.ownerId}, ${id}, 'pending') ON CONFLICT (owner_id, upload_id) DO NOTHING`;
  }

  /** Preserve failed inputs as standalone uploads when their execution records expire. */
  async preserveExpiredInput(tx: TransactionSql, job: JobRecord): Promise<void> {
    if (job.request.source.kind !== 'upload') return;
    const id = job.request.source.uri.toLowerCase();
    await lock(tx, job.ownerId, id);
    await tx`INSERT INTO media_v1.upload_retention (owner_id,upload_id,state)
      VALUES (${job.ownerId},${id},'awaiting_submit')
      ON CONFLICT (owner_id,upload_id) DO UPDATE SET state='awaiting_submit'`;
  }

  async drain(limit = 32): Promise<number> {
    const candidates = await this.sql<{ owner_id: string; upload_id: string }[]>`
      SELECT owner_id, upload_id FROM media_v1.upload_retention r WHERE ${eligible(this.sql)}
      ORDER BY next_attempt_at, owner_id, upload_id LIMIT ${limit}`;
    let removed = 0;
    let failed = false;
    for (const { owner_id: ownerId, upload_id: id } of candidates) {
      // The eligibility query needs a fresh snapshot after acquiring the lock, even if the
      // database's default transaction isolation is REPEATABLE READ.
      const outcome = await this.sql.begin('isolation level read committed', async (tx) => {
        await lock(tx, ownerId, id);
        // Submission, publication or another janitor may have won the lock since selection.
        const [current] = await tx`SELECT 1 FROM media_v1.upload_retention r
          WHERE owner_id = ${ownerId} AND upload_id = ${id} AND ${eligible(tx)}`;
        if (!current) return 'skipped';
        try {
          await this.files.removeUpload(ownerId, id);
        } catch {
          await tx`UPDATE media_v1.upload_retention SET next_attempt_at = clock_timestamp() + interval '30 seconds'
            WHERE owner_id = ${ownerId} AND upload_id = ${id}`;
          return 'failed';
        }
        await tx`DELETE FROM media_v1.upload_retention WHERE owner_id = ${ownerId} AND upload_id = ${id}`;
        return 'removed';
      });
      if (outcome === 'removed') removed++;
      if (outcome === 'failed') failed = true;
    }
    if (failed) throw new Error('Upload cleanup failed; pending removals will be retried');
    return removed;
  }
}
