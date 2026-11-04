import { resultSchema } from '@media-ingest/contracts';
import { aggregate, planChunks, validateChunk } from './chunks.js';
import { MediaError, LeaseLostError } from './errors.js';
import type { AdapterContext, JobRepository, Lease, SdkOptions } from './ports.js';

export class JobWorker {
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  constructor(
    private readonly options: SdkOptions,
    private readonly repository: JobRepository,
    private readonly now: () => number,
  ) {
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
      await this.process(lease, context, abort);
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

  private async process(
    lease: Lease,
    context: AdapterContext,
    abort: AbortController,
  ): Promise<void> {
    const { job, token } = lease;
    const source = await this.options.sources.resolve(job.request.source, context);
    abort.signal.throwIfAborted();
    const artifact = await this.options.sources.materialize(source, context);
    abort.signal.throwIfAborted();
    if (!artifact.fingerprint)
      throw new MediaError('invalid_source', 'Source adapter did not supply a content fingerprint');
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
    const runners = Array.from({ length: Math.min(this.concurrency, pending.length) }, async () => {
      while (cursor < pending.length) {
        abort.signal.throwIfAborted();
        const chunk = pending[cursor++];
        if (!chunk) break;
        const media = await this.options.media.chunk(artifact, chunk, inputFormat, context);
        abort.signal.throwIfAborted();
        const output = await this.options.provider.process(media, job.request, context);
        abort.signal.throwIfAborted();
        const validated = validateChunk(output, job.request, chunk);
        await this.repository.saveChunk(job.id, token, chunk.index, validated, this.now());
        job.chunks[String(chunk.index)] = validated;
      }
    });
    // AbortController preserves the first cause. Drain canceled siblings before recording it.
    await Promise.all(runners.map((runner) => runner.catch((error) => abort.abort(error))));
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
  }
}
