import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Sql, TransactionSql } from 'postgres';
import type { JobView, MediaResult } from '@media-ingest/contracts';
import { LeaseLostError, MediaError } from '@media-ingest/sdk';
import type {
  Chunk,
  ChunkOutput,
  JobRecord,
  JobRepository,
  Lease,
  ListJobs,
} from '@media-ingest/sdk';
import type { PostgresUploadRetention } from './upload-retention.js';

export { applyMigrations } from './migrations.js';
export { PostgresAuthStore } from './postgres-auth-store.js';

type Db = Sql | TransactionSql;
type JobRow = { data: JobRecord };
function data(rows: JobRow[]): JobRecord | null {
  return rows[0]?.data ?? null;
}

// clock_timestamp() advances while waiting for locks. PostgreSQL now() is fixed at BEGIN.
function clockExpression(sql: Db, clock?: () => number) {
  return clock
    ? sql`${clock()}::bigint`
    : sql`floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint`;
}

async function readClock(sql: Db, clock?: () => number): Promise<number> {
  const [row] = await sql<{ ms: string }[]>`SELECT ${clockExpression(sql, clock)} AS ms`;
  return Number(row!.ms);
}

async function writeJob(
  sql: Db,
  job: JobRecord,
  fence?: { token: string; clock?: () => number },
): Promise<void> {
  const guard = fence
    ? sql`AND lease_token=${fence.token} AND lease_expires_at > ${clockExpression(sql, fence.clock)}`
    : sql``;
  const result =
    await sql`UPDATE media_v1.jobs SET status=${job.status}, lease_token=${job.leaseToken},
    lease_expires_at=${job.leaseExpiresAt}, data=${sql.json(JSON.parse(JSON.stringify(job)))} WHERE id=${job.id} ${guard}`;
  if (fence && !result.count) throw new LeaseLostError();
}

/** Row locks serialize checkpoints, while lease tokens fence out superseded workers. */
export class PostgresJobRepository implements JobRepository {
  constructor(
    private readonly sql: Sql,
    private readonly clock?: () => number,
    private readonly uploads?: Pick<PostgresUploadRetention, 'submitted' | 'completed'>,
  ) {}

  async enqueue(job: JobRecord): Promise<JobRecord> {
    return this.sql.begin(async (transaction) => {
      const inserted = await transaction<JobRow[]>`INSERT INTO media_v1.jobs
        (id, owner_id, idempotency_key, status, lease_token, lease_expires_at, created_at, data)
        VALUES (${job.id}, ${job.ownerId}, ${job.idempotencyKey ?? null}, ${job.status},
          ${job.leaseToken}, ${job.leaseExpiresAt}, ${job.createdAt}, ${transaction.json(JSON.parse(JSON.stringify(job)))})
        ON CONFLICT (owner_id, idempotency_key) DO NOTHING RETURNING data`;
      const accepted =
        data(inserted) ??
        data(
          await transaction<JobRow[]>`SELECT data FROM media_v1.jobs
          WHERE owner_id=${job.ownerId} AND idempotency_key=${job.idempotencyKey ?? null} FOR SHARE`,
        );
      if (!accepted || accepted.requestHash !== job.requestHash) {
        throw new MediaError(
          'idempotency_conflict',
          'Idempotency key was already used with a different request',
        );
      }
      await this.uploads?.submitted(transaction, accepted, inserted.length > 0);
      return accepted;
    });
  }

  async get(ownerId: string, id: string): Promise<JobRecord | null> {
    return data(
      await this.sql<
        JobRow[]
      >`SELECT data FROM media_v1.jobs WHERE owner_id=${ownerId} AND id=${id}`,
    );
  }

  async list(ownerId: string, input: ListJobs): Promise<JobRecord[]> {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
    const rows = input.status
      ? await this.sql<
          JobRow[]
        >`SELECT data FROM media_v1.jobs WHERE owner_id=${ownerId} AND status=${input.status}
          ORDER BY created_at DESC, id DESC LIMIT ${limit}`
      : await this.sql<JobRow[]>`SELECT data FROM media_v1.jobs WHERE owner_id=${ownerId}
          ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
    return rows.map((row) => row.data);
  }

  async claim(_now: number, leaseMs: number): Promise<Lease | null> {
    return this.sql.begin(async (transaction) => {
      const job = data(
        await transaction<JobRow[]>`SELECT data FROM media_v1.jobs
        WHERE status='queued' OR (status='running' AND lease_expires_at <= ${clockExpression(transaction, this.clock)})
        ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!job) return null;
      const now = await readClock(transaction, this.clock);
      const token = randomUUID();
      Object.assign(job, {
        status: 'running',
        leaseToken: token,
        leaseExpiresAt: now + leaseMs,
        updatedAt: new Date(now).toISOString(),
        attempt: job.attempt + 1,
        error: null,
      });
      await writeJob(transaction, job);
      return { job, token };
    });
  }

  private async fenced(
    id: string,
    token: string,
    update: (job: JobRecord, now: number, transaction: TransactionSql) => void | Promise<void>,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const job = data(
        await transaction<JobRow[]>`SELECT data FROM media_v1.jobs
        WHERE id=${id} AND status='running' AND lease_token=${token} FOR UPDATE`,
      );
      if (!job) throw new LeaseLostError();
      const now = await readClock(transaction, this.clock);
      if (job.leaseExpiresAt === null || job.leaseExpiresAt <= now) throw new LeaseLostError();
      await update(job, now, transaction);
      job.updatedAt = new Date(now).toISOString();
      await writeJob(transaction, job, { token, clock: this.clock });
    });
  }

  async heartbeat(id: string, token: string, _now: number, leaseMs: number): Promise<void> {
    await this.fenced(id, token, (job, now) => {
      job.leaseExpiresAt = now + leaseMs;
    });
  }

  async savePlan(
    id: string,
    token: string,
    plan: Chunk[],
    sourceFingerprint: string,
    _now: number,
  ): Promise<void> {
    await this.fenced(id, token, (job) => {
      if (job.sourceFingerprint !== null && job.sourceFingerprint !== sourceFingerprint) {
        throw new MediaError('source_changed', 'Source changed since the previous attempt');
      }
      if (job.plan !== null && !isDeepStrictEqual(job.plan, plan)) {
        throw new MediaError('plan_changed', 'Chunk plan changed since the previous attempt');
      }
      job.plan = plan;
      job.sourceFingerprint = sourceFingerprint;
      job.totalChunks = plan.length;
    });
  }

  async saveChunk(
    id: string,
    token: string,
    index: number,
    output: ChunkOutput,
    _now: number,
  ): Promise<void> {
    await this.fenced(id, token, (job) => {
      if (!job.plan?.some((chunk) => chunk.index === index))
        throw new MediaError('invalid_chunk', 'Chunk is absent from the saved plan');
      job.chunks[String(index)] = output;
      job.completedChunks = Object.keys(job.chunks).length;
    });
  }

  async complete(id: string, token: string, result: MediaResult, _now: number): Promise<void> {
    await this.fenced(id, token, async (job, _now, transaction) => {
      if (!job.plan || job.plan.length !== Object.keys(job.chunks).length)
        throw new MediaError('incomplete_job', 'Cannot complete a job with missing chunks');
      Object.assign(job, {
        status: 'completed',
        result,
        error: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      // The final fenced write also rolls back this intent if the lease expired while waiting.
      await this.uploads?.completed(transaction, job);
    });
  }

  async fail(
    id: string,
    token: string,
    error: NonNullable<JobView['error']>,
    _now: number,
  ): Promise<void> {
    await this.fenced(id, token, (job) => {
      Object.assign(job, { status: 'failed', error, leaseToken: null, leaseExpiresAt: null });
    });
  }

  async retry(ownerId: string, id: string, now: number): Promise<JobRecord> {
    return this.sql.begin(async (transaction) => {
      const job = data(
        await transaction<
          JobRow[]
        >`SELECT data FROM media_v1.jobs WHERE owner_id=${ownerId} AND id=${id} FOR UPDATE`,
      );
      if (!job) throw new MediaError('not_found', 'Job not found');
      if (job.status !== 'failed')
        throw new MediaError('conflict', 'Only failed jobs can be retried');
      Object.assign(job, {
        status: 'queued',
        error: null,
        result: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date(now).toISOString(),
      });
      await writeJob(transaction, job);
      return job;
    });
  }
}
