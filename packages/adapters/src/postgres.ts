import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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

/** Migrations are explicit: API startup must not silently change a production schema. */
export async function applyMigrations(sql: Sql): Promise<void> {
  const migration = await readFile(
    new URL('../migrations/001_initial.sql', import.meta.url),
    'utf8',
  );
  await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(716385901)`;
    await transaction`CREATE SCHEMA IF NOT EXISTS media_v1`;
    await transaction`CREATE TABLE IF NOT EXISTS media_v1.migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const existing = await transaction`SELECT version FROM media_v1.migrations WHERE version = 1`;
    if (existing.length === 0) {
      await transaction.unsafe(migration);
      await transaction`INSERT INTO media_v1.migrations (version) VALUES (1)`;
    }
  });
}

type Db = Sql | TransactionSql;
type JobRow = { data: JobRecord };
function data(rows: JobRow[]): JobRecord | null {
  return rows[0]?.data ?? null;
}

async function writeJob(sql: Db, job: JobRecord): Promise<void> {
  await sql`UPDATE media_v1.jobs SET status=${job.status}, lease_token=${job.leaseToken},
    lease_expires_at=${job.leaseExpiresAt}, data=${sql.json(JSON.parse(JSON.stringify(job)))} WHERE id=${job.id}`;
}

/** Row locks serialize checkpoints, while lease tokens fence out superseded workers. */
export class PostgresJobRepository implements JobRepository {
  constructor(private readonly sql: Sql) {}

  async enqueue(job: JobRecord): Promise<JobRecord> {
    return this.sql.begin(async (transaction) => {
      const inserted = await transaction<JobRow[]>`INSERT INTO media_v1.jobs
        (id, owner_id, idempotency_key, status, lease_token, lease_expires_at, created_at, data)
        VALUES (${job.id}, ${job.ownerId}, ${job.idempotencyKey ?? null}, ${job.status},
          ${job.leaseToken}, ${job.leaseExpiresAt}, ${job.createdAt}, ${transaction.json(JSON.parse(JSON.stringify(job)))})
        ON CONFLICT (owner_id, idempotency_key) DO NOTHING RETURNING data`;
      if (inserted[0]) return inserted[0].data;
      const existing = data(
        await transaction<JobRow[]>`SELECT data FROM media_v1.jobs
        WHERE owner_id=${job.ownerId} AND idempotency_key=${job.idempotencyKey ?? null}`,
      );
      if (!existing || existing.requestHash !== job.requestHash) {
        throw new MediaError(
          'idempotency_conflict',
          'Idempotency key was already used with a different request',
        );
      }
      return existing;
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

  async claim(now: number, leaseMs: number): Promise<Lease | null> {
    return this.sql.begin(async (transaction) => {
      const job = data(
        await transaction<JobRow[]>`SELECT data FROM media_v1.jobs
        WHERE status='queued' OR (status='running' AND lease_expires_at <= ${now})
        ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!job) return null;
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
    now: number,
    update: (job: JobRecord) => void,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const job = data(
        await transaction<JobRow[]>`SELECT data FROM media_v1.jobs
        WHERE id=${id} AND status='running' AND lease_token=${token} AND lease_expires_at > ${now} FOR UPDATE`,
      );
      if (!job) throw new LeaseLostError();
      update(job);
      job.updatedAt = new Date(now).toISOString();
      await writeJob(transaction, job);
    });
  }

  async heartbeat(id: string, token: string, now: number, leaseMs: number): Promise<void> {
    await this.fenced(id, token, now, (job) => {
      job.leaseExpiresAt = now + leaseMs;
    });
  }

  async savePlan(
    id: string,
    token: string,
    plan: Chunk[],
    sourceFingerprint: string,
    now: number,
  ): Promise<void> {
    await this.fenced(id, token, now, (job) => {
      if (job.sourceFingerprint !== null && job.sourceFingerprint !== sourceFingerprint) {
        throw new MediaError('source_changed', 'Source changed since the previous attempt');
      }
      if (job.plan !== null && JSON.stringify(job.plan) !== JSON.stringify(plan)) {
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
    now: number,
  ): Promise<void> {
    await this.fenced(id, token, now, (job) => {
      if (!job.plan?.some((chunk) => chunk.index === index))
        throw new MediaError('invalid_chunk', 'Chunk is absent from the saved plan');
      job.chunks[String(index)] = output;
      job.completedChunks = Object.keys(job.chunks).length;
    });
  }

  async complete(id: string, token: string, result: MediaResult, now: number): Promise<void> {
    await this.fenced(id, token, now, (job) => {
      if (!job.plan || job.plan.length !== Object.keys(job.chunks).length)
        throw new MediaError('incomplete_job', 'Cannot complete a job with missing chunks');
      Object.assign(job, {
        status: 'completed',
        result,
        error: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
    });
  }

  async fail(
    id: string,
    token: string,
    error: NonNullable<JobView['error']>,
    now: number,
  ): Promise<void> {
    await this.fenced(id, token, now, (job) => {
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

/** Values contain only hashed bearer/code keys. `take` consumes codes atomically across instances. */
export class PostgresAuthStore {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => number = Date.now,
  ) {}

  async put(key: string, value: unknown, expiresAt: number): Promise<void> {
    await this.sql`INSERT INTO media_v1.auth_entries (key,value,expires_at)
      VALUES (${key},${this.sql.json(JSON.parse(JSON.stringify(value)))},${expiresAt})
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, expires_at=EXCLUDED.expires_at`;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const rows = await this.sql<
      { value: T }[]
    >`SELECT value FROM media_v1.auth_entries WHERE key=${key} AND expires_at > ${this.now()}`;
    return rows[0]?.value ?? null;
  }

  async take<T = unknown>(key: string): Promise<T | null> {
    const rows = await this.sql<
      { value: T; expires_at: string }[]
    >`DELETE FROM media_v1.auth_entries WHERE key=${key} RETURNING value, expires_at`;
    const row = rows[0];
    return row && Number(row.expires_at) > this.now() ? row.value : null;
  }

  async delete(key: string): Promise<void> {
    await this.sql`DELETE FROM media_v1.auth_entries WHERE key=${key}`;
  }

  async prune(): Promise<number> {
    const rows = await this
      .sql`DELETE FROM media_v1.auth_entries WHERE expires_at <= ${this.now()}`;
    return rows.count;
  }
}
