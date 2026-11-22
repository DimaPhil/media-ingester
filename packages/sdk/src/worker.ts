import { resultSchema, type ResolvedSource } from '@media-ingest/contracts';
import { findReusableResult, RESULT_CACHE_CANDIDATES } from './cache.js';
import { aggregate, NO_PAUSES, planChunks, validateChunk } from './chunks.js';
import { synthesisParts, synthesizeWhole } from './synthesis.js';
import { MediaError, LeaseLostError } from './errors.js';
import { describeFailure, type RunningStage } from './job-view.js';
import type {
  AdapterContext,
  Chunk,
  ChunkOutput,
  JobRepository,
  Lease,
  LoudnessProfile,
  MediaInspection,
  ResultLookup,
  SdkOptions,
} from './ports.js';

/** Where the current attempt is; failures record it with the chunk being processed, if any. */
interface Progress {
  stage: RunningStage;
  /** Chunk context for errors thrown while processing one chunk. */
  chunkErrors: WeakMap<object, Record<string, number>>;
}
const providerStages: ReadonlySet<RunningStage> = new Set([
  'processing',
  'synthesizing',
  'translating',
]);

/** Everything the chunk loop needs, whether the provider reads local or remote media. */
interface Prepared {
  fingerprint: string;
  inspection: MediaInspection;
  loudness?: LoudnessProfile;
  sizeBytes?: number;
  run(chunk: Chunk): Promise<ChunkOutput>;
}

export class JobWorker {
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  constructor(
    private readonly options: SdkOptions,
    private readonly repository: JobRepository,
    private readonly now: () => number,
    /** Runs when an attempt loses its lease, so the host can reclaim the job once it expires. */
    private readonly onLeaseLost?: (leaseMs: number) => void,
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
    const progress: Progress = { stage: 'resolving', chunkErrors: new WeakMap() };
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
      await this.process(lease, context, abort, progress);
    } catch (error) {
      if (error instanceof LeaseLostError) leaseLost = true;
      if (!leaseLost && !signal?.aborted) {
        const failure = describeFailure(error, {
          stage: progress.stage,
          attempt: job.attempt,
          ...(providerStages.has(progress.stage)
            ? { provider: job.request.provider, model: job.request.model }
            : {}),
          ...(error && typeof error === 'object' ? progress.chunkErrors.get(error) : undefined),
        });
        try {
          this.options.onProcessingError?.(job.id, error, failure);
        } catch {
          /* Observability must not prevent durable failure recording. */
        }
        try {
          await this.repository.fail(job.id, token, failure, this.now());
        } catch (writeError) {
          if (!(writeError instanceof LeaseLostError)) throw writeError;
          leaseLost = true;
        }
      }
    } finally {
      if (leaseLost && !signal?.aborted) this.onLeaseLost?.(this.leaseMs);
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
    progress: Progress,
  ): Promise<void> {
    const { job, token } = lease;
    /** Records a slow step before starting it: a few fenced writes per job, never per chunk. */
    const enter = async (stage: RunningStage) => {
      progress.stage = stage;
      await this.repository.saveStage?.(job.id, token, stage, this.now());
    };
    const source = await this.options.sources.resolve(job.request.source, context);
    abort.signal.throwIfAborted();
    // A stable site ID lets a retained result skip the download entirely.
    const mediaId = source.metadata.mediaId;
    if (
      typeof mediaId === 'string' &&
      mediaId.length &&
      (await this.reuse(lease, { mediaId }, abort.signal, source))
    )
      return;
    const prepared =
      this.remote(lease, source, context) ??
      (await this.local(lease, source, context, abort, enter));
    if (!prepared) return;
    abort.signal.throwIfAborted();
    const { inspection } = prepared;
    const plan =
      job.plan ??
      planChunks(
        inspection.durationMs,
        this.options.provider.chunkDurationMs(job.request),
        this.options.maxChunks,
        prepared.loudness,
      );
    if (job.plan && job.plan.at(-1)?.endMs !== inspection.durationMs)
      throw new MediaError('source_changed', 'Source duration changed since the saved plan');
    progress.stage = 'processing';
    await this.repository.savePlan(job.id, token, plan, prepared.fingerprint, this.now());
    let cursor = 0;
    const pending = plan.filter((chunk) => !job.chunks[String(chunk.index)]);
    const runners = Array.from({ length: Math.min(this.concurrency, pending.length) }, async () => {
      while (cursor < pending.length) {
        abort.signal.throwIfAborted();
        const chunk = pending[cursor++];
        if (!chunk) break;
        let validated: ChunkOutput;
        try {
          const output = await prepared.run(chunk);
          abort.signal.throwIfAborted();
          validated = validateChunk(output, job.request, chunk);
        } catch (error) {
          if (error && typeof error === 'object' && !progress.chunkErrors.has(error))
            progress.chunkErrors.set(error, {
              chunkIndex: chunk.index,
              chunkStartMs: chunk.startMs,
              chunkEndMs: chunk.endMs,
            });
          throw error;
        }
        await this.repository.saveChunk(job.id, token, chunk.index, validated, this.now());
        job.chunks[String(chunk.index)] = validated;
      }
    });
    // AbortController preserves the first cause. Drain canceled siblings before recording it.
    await Promise.all(runners.map((runner) => runner.catch((error) => abort.abort(error))));
    abort.signal.throwIfAborted();
    const result = aggregate(plan, job.chunks, job.request);
    if (
      job.request.kind === 'understanding' &&
      plan.length > 1 &&
      this.options.provider.synthesize
    ) {
      // Chunk answers see only their span; one more call answers the task for the whole media.
      await enter('synthesizing');
      const whole = await synthesizeWhole(
        this.options.provider,
        synthesisParts(plan, job.chunks),
        inspection.durationMs,
        job.request,
        context,
      );
      abort.signal.throwIfAborted();
      if (whole) {
        result.text = whole.text;
        result.timeRanges = whole.timeRanges;
      }
    }
    if (job.request.targetLanguage) {
      if (!this.options.provider.translate)
        throw new MediaError('unsupported_translation', 'Provider does not support translation');
      await enter('translating');
      result.translatedText = await this.options.provider.translate(
        result.text,
        job.request,
        context,
      );
    }
    abort.signal.throwIfAborted();
    await this.repository.complete(job.id, token, resultSchema.parse(result), this.now(), {
      source,
      inspection,
      ...(prepared.sizeBytes === undefined ? {} : { sizeBytes: prepared.sizeBytes }),
    });
  }

  /**
   * Media the provider reads from its site without download or local processing. The site ID
   * is the identity; boundaries overlap because the audio cannot be measured.
   */
  private remote(
    { job }: Lease,
    source: ResolvedSource,
    context: AdapterContext,
  ): Prepared | undefined {
    const { provider } = this.options;
    const mediaId = source.metadata.mediaId;
    if (typeof mediaId !== 'string' || !mediaId || !provider.processRemote) return undefined;
    const remote = provider.remoteMedia?.(job.request, source);
    if (!remote) return undefined;
    if (!Number.isFinite(remote.durationMs) || remote.durationMs <= 0)
      throw new MediaError('invalid_source', 'Remote media needs a positive duration');
    const site =
      typeof source.metadata.downloadProvider === 'string' ? source.metadata.downloadProvider : '';
    const fingerprint = `remote:${source.source.kind}:${site}:${mediaId}`;
    if (job.sourceFingerprint !== null && job.sourceFingerprint !== fingerprint)
      throw new MediaError(
        'source_changed',
        'Source changed since the saved chunks; submit a new job',
      );
    return {
      fingerprint,
      inspection: { durationMs: remote.durationMs, hasAudio: true, hasVideo: true },
      ...(job.plan ? {} : { loudness: NO_PAUSES }),
      run: (chunk) => provider.processRemote!(remote, chunk, job.request, context),
    };
  }

  /** Downloads and inspects the source; returns undefined when a retained result completed the job. */
  private async local(
    lease: Lease,
    source: ResolvedSource,
    context: AdapterContext,
    abort: AbortController,
    enter: (stage: RunningStage) => Promise<void>,
  ): Promise<Prepared | undefined> {
    const { job } = lease;
    await enter('downloading');
    const audioOnly = this.options.provider.sourceMedia?.(job.request) === 'audio';
    const artifact = await this.options.sources.materialize(
      source,
      context,
      audioOnly ? { audioOnly } : undefined,
    );
    abort.signal.throwIfAborted();
    if (!artifact.fingerprint)
      throw new MediaError('invalid_source', 'Source adapter did not supply a content fingerprint');
    if (job.sourceFingerprint !== null && job.sourceFingerprint !== artifact.fingerprint)
      throw new MediaError(
        'source_changed',
        'Source bytes changed since the saved chunks; submit a new job',
      );
    if (await this.reuse(lease, { fingerprint: artifact.fingerprint }, abort.signal))
      return undefined;
    await enter('inspecting');
    const inspection = await this.options.media.inspect(artifact, context);
    if (job.request.kind === 'transcription' && !inspection.hasAudio)
      throw new MediaError('invalid_media', 'Source has no audio');
    const inputFormat =
      this.options.provider.inputFormat?.(job.request, inspection) ?? job.request.kind;
    // A saved plan is authoritative; analysis only shapes the first attempt's boundaries.
    let loudness: LoudnessProfile | undefined;
    if (
      !job.plan &&
      inspection.hasAudio &&
      inspection.durationMs > this.options.provider.chunkDurationMs(job.request) &&
      this.options.media.loudness
    ) {
      await enter('planning');
      loudness = await this.options.media.loudness(artifact, context);
    }
    return {
      fingerprint: artifact.fingerprint,
      inspection,
      ...(loudness ? { loudness } : {}),
      ...(artifact.sizeBytes === undefined ? {} : { sizeBytes: artifact.sizeBytes }),
      run: async (chunk) => {
        const media = await this.options.media.chunk(artifact, chunk, inputFormat, context);
        abort.signal.throwIfAborted();
        return this.options.provider.process(media, job.request, context);
      },
    };
  }

  /** Completes the job with an equivalent retained result unless the request forces a fresh run. */
  private async reuse(
    { job, token }: Lease,
    lookup: ResultLookup,
    signal: AbortSignal,
    site?: ResolvedSource,
  ): Promise<boolean> {
    if (job.request.force || !this.repository.findResults || !this.repository.completeFromCache)
      return false;
    const candidates = await this.repository.findResults(
      job.ownerId,
      lookup,
      RESULT_CACHE_CANDIDATES,
    );
    signal.throwIfAborted();
    const cached = findReusableResult(job.request, candidates, site);
    if (!cached) return false;
    await this.repository.completeFromCache(
      job.id,
      token,
      { ...cached, result: resultSchema.parse(cached.result) },
      this.now(),
    );
    return true;
  }
}
