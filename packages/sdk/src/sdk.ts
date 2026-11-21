import { createHash, randomUUID } from 'node:crypto';
import {
  jobSchema,
  requestSchema,
  historyInputSchema,
  type JobView,
  type MediaRequest,
  type ListHistory,
} from '@media-ingest/contracts';
import { MediaError } from './errors.js';
import { MemoryJobRepository } from './memory-repository.js';
import { JobWorker } from './worker.js';
import { runWorkerLoops, WorkSignal, type WorkerLoopOptions } from './workers.js';
import type { JobRecord, JobRepository, ListJobs, SdkOptions } from './ports.js';

export { planChunks, aggregate, stitchOverlap, NO_PAUSES } from './chunks.js';

export class MediaSdk {
  readonly repository: JobRepository;
  private readonly now: () => number;
  private readonly worker: JobWorker;
  private readonly work = new WorkSignal();
  constructor(private readonly options: SdkOptions) {
    this.repository = options.repository ?? new MemoryJobRepository();
    this.now = options.clock ?? Date.now;
    this.worker = new JobWorker(options, this.repository, this.now, (leaseMs) => {
      // The abandoned job becomes claimable once its lease expires; look again then.
      setTimeout(() => this.wake(), leaseMs + 1000).unref?.();
    });
  }

  async submit(ownerId: string, input: MediaRequest, idempotencyKey?: string): Promise<JobView> {
    if (
      !ownerId ||
      (idempotencyKey !== undefined && (!idempotencyKey.length || idempotencyKey.length > 200))
    )
      throw new MediaError('invalid_request', 'Owner and idempotency key must be valid');
    const parsed = requestSchema.parse(input);
    const request = requestSchema.parse({
      ...parsed,
      model: this.options.provider.resolveModel(parsed),
    });
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const timestamp = new Date(this.now()).toISOString();
    const job: JobRecord = {
      id: randomUUID(),
      ownerId,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      requestHash,
      request,
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      attempt: 0,
      completedChunks: 0,
      totalChunks: 0,
      result: null,
      error: null,
      plan: null,
      sourceFingerprint: null,
      chunks: {},
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const stored = jobSchema.parse(await this.repository.enqueue(job));
    // Also wakes idle hosts for replays: their idle hook can release a republished upload.
    this.wake();
    return stored;
  }

  async get(ownerId: string, id: string): Promise<JobView> {
    const job = await this.repository.get(ownerId, id);
    if (!job) throw new MediaError('not_found', 'Job not found');
    return jobSchema.parse(job);
  }

  async list(ownerId: string, input: ListJobs = { limit: 20 }): Promise<JobView[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new MediaError('invalid_request', 'Limit must be between 1 and 100');
    return (await this.repository.list(ownerId, input)).map((job) => jobSchema.parse(job));
  }

  async retry(ownerId: string, id: string): Promise<JobView> {
    const job = jobSchema.parse(await this.repository.retry(ownerId, id, this.now()));
    this.wake();
    return job;
  }

  history(ownerId: string, input: ListHistory = { limit: 20 }) {
    if (!this.repository.history)
      throw new MediaError('unsupported_history', 'Repository does not support retained history');
    return this.repository.history(ownerId, historyInputSchema.parse(input));
  }

  async getResult(ownerId: string, id: string) {
    if (!this.repository.getResult)
      throw new MediaError('unsupported_history', 'Repository does not support retained history');
    const result = await this.repository.getResult(ownerId, id);
    if (!result) throw new MediaError('not_found', 'Result not found');
    return result;
  }

  /** Processes one durable job. Returns false when no job is claimable. */
  runNext(signal?: AbortSignal): Promise<boolean> {
    return this.worker.runNext(signal);
  }

  /** Wakes idle `runWorkers` loops in this process to look for claimable jobs. */
  wake(): void {
    this.work.notify();
  }

  /**
   * Runs worker loops until `options.signal` aborts. Each loop drains claimable jobs, then sleeps
   * without touching the repository until `submit`, `retry` or `wake` is called, or until the
   * shared `idlePollMs` fallback fires. Every loop looks for work once at startup.
   */
  runWorkers(options: WorkerLoopOptions): Promise<void> {
    return runWorkerLoops((signal) => this.runNext(signal), this.work, options);
  }
}
