import { createHash, randomUUID } from 'node:crypto';
import {
  jobSchema,
  requestSchema,
  resultSchema,
  type JobView,
  type MediaRequest,
  type MediaResult,
} from '@media-ingest/contracts';
import { LeaseLostError, MediaError } from './errors.js';
import { MemoryJobRepository } from './memory-repository.js';
import type {
  AdapterContext,
  Chunk,
  ChunkOutput,
  JobRecord,
  JobRepository,
  ListJobs,
  SdkOptions,
} from './ports.js';

export function planChunks(
  durationMs: number,
  chunkDurationMs: number,
  maxChunks = 10000,
): Chunk[] {
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    !Number.isFinite(chunkDurationMs) ||
    chunkDurationMs <= 0
  )
    throw new MediaError('invalid_media', 'Media and chunk durations must be finite and positive');
  const count = Math.ceil(durationMs / chunkDurationMs);
  if (count > maxChunks)
    throw new MediaError('media_too_large', `Media exceeds the ${maxChunks} chunk limit`);
  return Array.from({ length: count }, (_, index) => ({
    index,
    startMs: index * chunkDurationMs,
    endMs: Math.min(durationMs, (index + 1) * chunkDurationMs),
  }));
}

export function aggregate(
  plan: Chunk[],
  outputs: Record<string, ChunkOutput>,
  request: MediaRequest,
): MediaResult {
  const ordered = [...plan].sort((a, b) => a.index - b.index);
  const result: MediaResult = {
    kind: request.kind,
    provider: request.provider,
    model: request.model!,
    text: '',
    segments: [],
    timeRanges: [],
    detectedLanguage: null,
  };
  const texts: string[] = [];
  for (const chunk of ordered) {
    const output = outputs[String(chunk.index)];
    if (!output) throw new MediaError('missing_chunk', 'A completed chunk is missing');
    texts.push(output.text);
    if (output.provenance) {
      result.provenance = { ...result.provenance, ...output.provenance };
    }
    result.detectedLanguage ??= output.detectedLanguage;
    for (const segment of output.segments)
      result.segments.push({
        ...segment,
        startMs: segment.startMs + chunk.startMs,
        endMs: segment.endMs + chunk.startMs,
      });
    for (const range of output.timeRanges)
      result.timeRanges.push({
        ...range,
        startMs: range.startMs + chunk.startMs,
        endMs: range.endMs + chunk.startMs,
      });
  }
  result.text = texts.join(request.kind === 'understanding' ? '\n\n' : ' ').trim();
  result.segments.sort((a, b) => a.startMs - b.startMs);
  result.timeRanges.sort((a, b) => a.startMs - b.startMs);
  return resultSchema.parse(result);
}

export class MediaSdk {
  readonly repository: JobRepository;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  constructor(private readonly options: SdkOptions) {
    this.repository = options.repository ?? new MemoryJobRepository();
    this.now = options.clock ?? Date.now;
    this.concurrency = options.chunkConcurrency ?? 2;
    this.leaseMs = options.leaseMs ?? 60000;
    this.heartbeatMs = options.heartbeatMs ?? Math.floor(this.leaseMs / 3);
    if (
      !Number.isInteger(this.concurrency) ||
      this.concurrency < 1 ||
      !Number.isFinite(this.leaseMs) ||
      this.leaseMs <= 0 ||
      !Number.isFinite(this.heartbeatMs) ||
      this.heartbeatMs <= 0 ||
      this.heartbeatMs >= this.leaseMs ||
      (options.maxChunks !== undefined &&
        (!Number.isInteger(options.maxChunks) || options.maxChunks < 1))
    )
      throw new MediaError(
        'invalid_configuration',
        'Invalid worker concurrency, chunk limit, or lease timing',
      );
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
    return jobSchema.parse(await this.repository.enqueue(job));
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
    return jobSchema.parse(await this.repository.retry(ownerId, id, this.now()));
  }

  /** Processes one durable job. Returns false when no job is claimable. */
  async runNext(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const lease = await this.repository.claim(this.now(), this.leaseMs);
    if (!lease) return false;
    const { job, token } = lease;
    const abort = new AbortController();
    const externalAbort = () => abort.abort(signal?.reason);
    signal?.addEventListener('abort', externalAbort, { once: true });
    if (signal?.aborted) externalAbort();
    const context: AdapterContext = {
      ownerId: job.ownerId,
      jobId: job.id,
      attempt: job.attempt,
      signal: abort.signal,
    };
    let heartbeat: Promise<void> | undefined;
    let leaseLost = false;
    const timer = setInterval(() => {
      if (heartbeat || abort.signal.aborted) return;
      heartbeat = this.repository
        .heartbeat(job.id, token, this.now(), this.leaseMs)
        .catch(() => {
          leaseLost = true;
          abort.abort(new LeaseLostError());
        })
        .finally(() => {
          heartbeat = undefined;
        });
    }, this.heartbeatMs);
    timer.unref?.();
    try {
      const source = await this.options.sources.resolve(job.request.source, context);
      abort.signal.throwIfAborted();
      const artifact = await this.options.sources.materialize(source, context);
      abort.signal.throwIfAborted();
      if (!artifact.fingerprint)
        throw new MediaError(
          'invalid_source',
          'Source adapter did not supply a content fingerprint',
        );
      if (job.sourceFingerprint !== null && job.sourceFingerprint !== artifact.fingerprint)
        throw new MediaError(
          'source_changed',
          'Source bytes changed since the saved chunks; submit a new job',
        );
      const inspection = await this.options.media.inspect(artifact, context);
      if (job.request.kind === 'transcription' && !inspection.hasAudio)
        throw new MediaError('invalid_media', 'Source has no audio');
      const inputFormat =
        this.options.provider.inputFormat?.(job.request, inspection) ?? job.request.kind;
      const plan =
        job.plan ??
        planChunks(
          inspection.durationMs,
          this.options.provider.chunkDurationMs(job.request),
          this.options.maxChunks,
        );
      if (job.plan && job.plan.at(-1)?.endMs !== inspection.durationMs)
        throw new MediaError('source_changed', 'Source duration changed since the saved plan');
      await this.repository.savePlan(job.id, token, plan, artifact.fingerprint, this.now());
      let cursor = 0;
      const pending = plan.filter((chunk) => !job.chunks[String(chunk.index)]);
      const runners = Array.from(
        { length: Math.min(this.concurrency, pending.length) },
        async () => {
          while (cursor < pending.length) {
            abort.signal.throwIfAborted();
            const chunk = pending[cursor++];
            if (!chunk) break;
            const media = await this.options.media.chunk(artifact, chunk, inputFormat, context);
            abort.signal.throwIfAborted();
            const output = await this.options.provider.process(media, job.request, context);
            abort.signal.throwIfAborted();
            // Validate provider output through the public result schema before checkpointing.
            const validated = resultSchema.parse({
              ...output,
              kind: job.request.kind,
              provider: job.request.provider,
              model: job.request.model,
            });
            for (const range of [...validated.segments, ...validated.timeRanges]) {
              if (range.endMs < range.startMs || range.endMs > chunk.endMs - chunk.startMs)
                throw new MediaError(
                  'invalid_provider_output',
                  'Provider timestamps must fall within the chunk',
                );
            }
            await this.repository.saveChunk(job.id, token, chunk.index, validated, this.now());
            job.chunks[String(chunk.index)] = validated;
          }
        },
      );
      // Wait for every in-flight write before marking failure or cleaning artifacts.
      const outcomes = await Promise.allSettled(
        runners.map((runner) =>
          runner.catch((error) => {
            abort.abort(error);
            throw error;
          }),
        ),
      );
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      abort.signal.throwIfAborted();
      const result = aggregate(plan, job.chunks, job.request);
      if (job.request.targetLanguage) {
        if (!this.options.provider.translate)
          throw new MediaError('unsupported_translation', 'Provider does not support translation');
        result.translatedText = await this.options.provider.translate(
          result.text,
          job.request,
          context,
        );
      }
      abort.signal.throwIfAborted();
      await this.repository.complete(job.id, token, resultSchema.parse(result), this.now());
    } catch (error) {
      if (!(error instanceof LeaseLostError) && !leaseLost && !signal?.aborted) {
        try {
          this.options.onProcessingError?.(job.id, error);
        } catch {
          /* Observability must not prevent durable failure recording. */
        }
        const failure =
          error instanceof MediaError
            ? { code: error.code, message: error.message, retryable: error.retryable }
            : {
                code: 'processing_failed',
                message: 'Media processing failed; check server logs',
                retryable: true,
              };
        try {
          await this.repository.fail(job.id, token, failure, this.now());
        } catch (writeError) {
          if (!(writeError instanceof LeaseLostError)) throw writeError;
        }
      }
    } finally {
      clearInterval(timer);
      await heartbeat;
      signal?.removeEventListener('abort', externalAbort);
      try {
        await this.options.media.cleanup(context);
      } catch (error) {
        this.options.onCleanupError?.(error);
      }
    }
    return true;
  }
}
