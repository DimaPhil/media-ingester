import { randomUUID } from 'node:crypto';
import type { MediaResult, JobView } from '@media-ingest/contracts';
import { LeaseLostError, MediaError } from './errors.js';
import type { Chunk, ChunkOutput, JobRecord, JobRepository, Lease, ListJobs } from './ports.js';

/** Reference implementation: mutations run synchronously before their promises resolve. */
export class MemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, JobRecord>();

  async enqueue(job: JobRecord): Promise<JobRecord> {
    if (job.idempotencyKey !== undefined) {
      const prior = [...this.jobs.values()].find(
        (value) => value.ownerId === job.ownerId && value.idempotencyKey === job.idempotencyKey,
      );
      if (prior) {
        if (prior.requestHash !== job.requestHash)
          throw new MediaError(
            'idempotency_conflict',
            'Idempotency key was already used for a different request',
          );
        return structuredClone(prior);
      }
    }
    if (this.jobs.has(job.id)) throw new MediaError('conflict', 'Job ID already exists');
    this.jobs.set(job.id, structuredClone(job));
    return structuredClone(job);
  }

  async get(ownerId: string, id: string): Promise<JobRecord | null> {
    const job = this.jobs.get(id);
    return job?.ownerId === ownerId ? structuredClone(job) : null;
  }

  async list(ownerId: string, input: ListJobs): Promise<JobRecord[]> {
    return structuredClone(
      [...this.jobs.values()]
        .filter((job) => job.ownerId === ownerId && (!input.status || job.status === input.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, input.limit),
    );
  }

  async claim(now: number, leaseMs: number): Promise<Lease | null> {
    const job = [...this.jobs.values()]
      .filter(
        (value) =>
          value.status === 'queued' ||
          (value.status === 'running' && (value.leaseExpiresAt ?? 0) <= now),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
    if (!job) return null;
    const token = randomUUID();
    Object.assign(job, {
      status: 'running',
      leaseToken: token,
      leaseExpiresAt: now + leaseMs,
      attempt: job.attempt + 1,
      updatedAt: new Date(now).toISOString(),
      error: null,
    });
    return { job: structuredClone(job), token };
  }

  private fenced(id: string, token: string, now: number): JobRecord {
    const job = this.jobs.get(id);
    if (
      !job ||
      job.status !== 'running' ||
      job.leaseToken !== token ||
      (job.leaseExpiresAt ?? 0) <= now
    )
      throw new LeaseLostError();
    job.updatedAt = new Date(now).toISOString();
    return job;
  }

  async heartbeat(id: string, token: string, now: number, leaseMs: number): Promise<void> {
    this.fenced(id, token, now).leaseExpiresAt = now + leaseMs;
  }

  async savePlan(
    id: string,
    token: string,
    plan: Chunk[],
    sourceFingerprint: string,
    now: number,
  ): Promise<void> {
    const job = this.fenced(id, token, now);
    if (job.sourceFingerprint !== null && job.sourceFingerprint !== sourceFingerprint)
      throw new MediaError(
        'source_changed',
        'Source bytes changed since the saved chunks; submit a new job',
      );
    if (job.plan !== null && JSON.stringify(job.plan) !== JSON.stringify(plan))
      throw new MediaError('plan_changed', 'Chunk plan changed since it was saved');
    job.plan = structuredClone(plan);
    job.sourceFingerprint = sourceFingerprint;
    job.totalChunks = plan.length;
  }

  async saveChunk(
    id: string,
    token: string,
    index: number,
    output: ChunkOutput,
    now: number,
  ): Promise<void> {
    const job = this.fenced(id, token, now);
    if (!job.plan?.some((chunk) => chunk.index === index))
      throw new MediaError('invalid_chunk', 'Chunk does not belong to the saved plan');
    job.chunks[String(index)] = structuredClone(output);
    job.completedChunks = Object.keys(job.chunks).length;
  }

  async complete(id: string, token: string, result: MediaResult, now: number): Promise<void> {
    const job = this.fenced(id, token, now);
    if (!job.plan || job.completedChunks !== job.totalChunks)
      throw new MediaError('incomplete_job', 'Cannot complete a job with missing chunks');
    Object.assign(job, {
      status: 'completed',
      result: structuredClone(result),
      error: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
  }

  async fail(
    id: string,
    token: string,
    error: NonNullable<JobView['error']>,
    now: number,
  ): Promise<void> {
    Object.assign(this.fenced(id, token, now), {
      status: 'failed',
      error: structuredClone(error),
      leaseToken: null,
      leaseExpiresAt: null,
    });
  }

  async retry(ownerId: string, id: string, now: number): Promise<JobRecord> {
    const job = this.jobs.get(id);
    if (!job || job.ownerId !== ownerId) throw new MediaError('not_found', 'Job not found');
    if (job.status !== 'failed')
      throw new MediaError('conflict', 'Only failed jobs can be retried');
    Object.assign(job, { status: 'queued', error: null, updatedAt: new Date(now).toISOString() });
    return structuredClone(job);
  }
}
