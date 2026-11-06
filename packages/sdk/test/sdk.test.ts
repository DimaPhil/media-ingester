import { describe, expect, it, vi } from 'vitest';
import type { MediaRequest } from '@media-ingest/contracts';
import {
  aggregate,
  LeaseLostError,
  MediaError,
  MediaSdk,
  MemoryJobRepository,
  planChunks,
} from '../src/index.js';
import type { AdapterContext, ChunkOutput, SdkOptions } from '../src/index.js';

const request: MediaRequest = {
  kind: 'transcription',
  source: { kind: 'http', uri: 'https://example.test/media' },
  provider: 'openai',
};
const output: ChunkOutput = {
  text: 'hello',
  segments: [{ startMs: 0, endMs: 500, text: 'hello' }],
  timeRanges: [],
  detectedLanguage: 'en',
};
function fixture(overrides: Partial<SdkOptions> = {}) {
  const repository = new MemoryJobRepository();
  const sources = {
    resolve: vi.fn(async (source: MediaRequest['source']) => ({
      source,
      fileName: 'input',
      metadata: {},
    })),
    materialize: vi.fn(async () => ({
      uri: 'input',
      fileName: 'input',
      fingerprint: 'content-v1',
    })),
  };
  const media = {
    inspect: vi.fn(async () => ({ durationMs: 2000, hasAudio: true, hasVideo: true })),
    chunk: vi.fn(async () => ({ uri: 'chunk', fileName: 'chunk', fingerprint: 'chunk-v1' })),
    cleanup: vi.fn(async () => {}),
  };
  const provider = {
    resolveModel: vi.fn(() => 'test-model'),
    chunkDurationMs: vi.fn(() => 1000),
    process: vi.fn(async () => structuredClone(output)),
    translate: vi.fn(async () => 'bonjour'),
  };
  const sdk = new MediaSdk({ repository, sources, media, provider, ...overrides });
  return { sdk, repository, sources, media, provider };
}

describe('SDK execution', () => {
  it('keeps existing repository implementations usable without history support', async () => {
    const base = fixture();
    const legacy = new Proxy(base.repository, {
      get(target, key) {
        if (key === 'history' || key === 'getResult') return undefined;
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { sdk } = fixture({ repository: legacy });
    const job = await sdk.submit('alice', request);
    await sdk.runNext();
    expect((await sdk.get('alice', job.id)).status).toBe('completed');
    expect(() => sdk.history('alice')).toThrow('does not support retained history');
    await expect(sdk.getResult('alice', job.id)).rejects.toThrow(
      'does not support retained history',
    );
  });

  it('retains owner-scoped metadata and paginates in-memory result history', async () => {
    const { sdk } = fixture();
    const first = await sdk.submit('alice', request);
    await sdk.runNext();
    await sdk.submit('alice', { ...request, force: true });
    await sdk.runNext();
    const other = await sdk.submit('bob', request);
    await sdk.runNext();
    const page = await sdk.history('alice', { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextBefore).toBeTruthy();
    expect((await sdk.history('alice', { limit: 1, before: page.nextBefore! })).items).toHaveLength(
      1,
    );
    expect((await sdk.history('alice', { limit: 20, before: other.id })).items).toEqual([]);
    expect((await sdk.history('alice', { limit: 20, mediaId: 'missing' })).items).toEqual([]);
    const result = await sdk.getResult('alice', first.id);
    expect(result.media?.source.fileName).toBe('input');
    expect(result.result.text).toBeTruthy();
    await expect(sdk.getResult('bob', first.id)).rejects.toThrow('Result not found');
  });
  it('reuses an equivalent retained result by content fingerprint until forced', async () => {
    const { sdk, provider, sources } = fixture();
    const first = await sdk.submit('alice', { ...request, prompt: 'names' });
    await sdk.runNext();
    expect(provider.process).toHaveBeenCalledTimes(2);

    // Transcription ignores its prompt hint and a different URI with identical bytes still matches.
    const cached = await sdk.submit('alice', {
      ...request,
      source: { kind: 'http', uri: 'https://mirror.test/media' },
    });
    await sdk.runNext();
    const view = await sdk.get('alice', cached.id);
    expect(view).toMatchObject({ status: 'completed', cachedFrom: first.id, completedChunks: 0 });
    expect(view.result).toEqual((await sdk.get('alice', first.id)).result);
    expect(provider.process).toHaveBeenCalledTimes(2);
    expect(sources.materialize).toHaveBeenCalledTimes(2);
    expect((await sdk.history('alice')).items).toHaveLength(1);

    provider.process.mockResolvedValue({ ...output, text: 'fresh' });
    const forced = await sdk.submit('alice', { ...request, force: true });
    await sdk.runNext();
    const forcedView = await sdk.get('alice', forced.id);
    expect(forcedView.cachedFrom).toBeUndefined();
    expect(forcedView.result?.text).toBe('fresh fresh');
    expect(provider.process).toHaveBeenCalledTimes(4);

    // The newest retained output wins afterwards.
    const after = await sdk.submit('alice', request);
    await sdk.runNext();
    expect((await sdk.get('alice', after.id)).cachedFrom).toBe(forced.id);
    expect(provider.process).toHaveBeenCalledTimes(4);
  });

  it('matches understanding prompts, languages, provider, model and owner exactly', async () => {
    const { sdk, provider } = fixture();
    const understanding: MediaRequest = {
      kind: 'understanding',
      source: request.source,
      provider: 'google-gemini',
      prompt: 'Summarize',
    };
    const first = await sdk.submit('alice', understanding);
    await sdk.runNext();
    const variants: MediaRequest[] = [
      { ...understanding, prompt: 'Summarize briefly' },
      { ...understanding, provider: 'codex' },
      { ...understanding, model: 'other-model' },
      { ...understanding, targetLanguage: 'fr' },
      { ...understanding, inputLanguage: 'en' },
      { ...request },
    ];
    provider.resolveModel.mockImplementation((value: MediaRequest) => value.model ?? 'test-model');
    for (const variant of variants) {
      const job = await sdk.submit('alice', variant);
      await sdk.runNext();
      expect((await sdk.get('alice', job.id)).cachedFrom).toBeUndefined();
    }
    const bob = await sdk.submit('bob', understanding);
    await sdk.runNext();
    expect((await sdk.get('bob', bob.id)).cachedFrom).toBeUndefined();
    const same = await sdk.submit('alice', understanding);
    await sdk.runNext();
    expect((await sdk.get('alice', same.id)).cachedFrom).toBe(first.id);
    expect(provider.process).toHaveBeenCalledTimes(2 * (variants.length + 2));
  });

  it('reuses by site media ID before download, scoped to source kind and download site', async () => {
    const { sdk, provider, sources } = fixture();
    const youtube: MediaRequest = {
      ...request,
      source: { kind: 'youtube', uri: 'https://youtu.be/abc' },
    };
    sources.resolve.mockImplementation(async (source: MediaRequest['source']) => ({
      source,
      fileName: 'input',
      metadata: { mediaId: 'abc', downloadProvider: source.kind },
    }));
    const first = await sdk.submit('alice', youtube);
    await sdk.runNext();
    const cached = await sdk.submit('alice', {
      ...youtube,
      source: { kind: 'youtube', uri: 'https://www.youtube.com/watch?v=abc' },
    });
    await sdk.runNext();
    expect((await sdk.get('alice', cached.id)).cachedFrom).toBe(first.id);
    expect(sources.materialize).toHaveBeenCalledOnce();
    expect(provider.process).toHaveBeenCalledTimes(2);

    // Same site ID on another site is not the same media; identical bytes still match afterwards.
    const other = await sdk.submit('alice', {
      ...youtube,
      source: { kind: 'instagram', uri: 'https://instagram.com/p/abc' },
    });
    await sdk.runNext();
    expect((await sdk.get('alice', other.id)).cachedFrom).toBe(first.id);
    expect(sources.materialize).toHaveBeenCalledTimes(2);
    expect(provider.process).toHaveBeenCalledTimes(2);
  });

  it('processes normally when the repository does not support result reuse', async () => {
    const base = fixture();
    const legacy = new Proxy(base.repository, {
      get(target, key) {
        if (key === 'findResults' || key === 'completeFromCache') return undefined;
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { sdk, provider } = fixture({ repository: legacy });
    await sdk.submit('alice', request);
    await sdk.runNext();
    const second = await sdk.submit('alice', request);
    await sdk.runNext();
    expect((await sdk.get('alice', second.id)).cachedFrom).toBeUndefined();
    expect(provider.process).toHaveBeenCalledTimes(4);
  });

  it('lets a provider select video for transcription while preserving fallback request-kind behavior', async () => {
    const base = fixture();
    const inputFormat = vi.fn(() => 'video' as const);
    const sdk = new MediaSdk({
      repository: base.repository,
      sources: base.sources,
      media: base.media,
      provider: { ...base.provider, inputFormat },
    });
    const job = await sdk.submit('alice', { ...request, provider: 'google-gemini' });
    await sdk.runNext();
    expect(inputFormat).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'transcription', provider: 'google-gemini' }),
      { durationMs: 2000, hasAudio: true, hasVideo: true },
    );
    expect(base.media.chunk).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'video',
      expect.anything(),
    );
    expect((await sdk.get('alice', job.id)).status).toBe('completed');

    const fallback = fixture();
    await fallback.sdk.submit('alice', request);
    await fallback.sdk.runNext();
    expect(fallback.media.chunk).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'transcription',
      expect.anything(),
    );
  });

  it('still rejects transcription of silent video before provider format selection', async () => {
    const base = fixture();
    base.media.inspect.mockResolvedValue({ durationMs: 2000, hasAudio: false, hasVideo: true });
    const inputFormat = vi.fn(() => 'video' as const);
    const sdk = new MediaSdk({
      sources: base.sources,
      media: base.media,
      provider: { ...base.provider, inputFormat },
    });
    const job = await sdk.submit('alice', { ...request, provider: 'google-gemini' });
    await sdk.runNext();
    expect((await sdk.get('alice', job.id)).error?.code).toBe('invalid_media');
    expect(inputFormat).not.toHaveBeenCalled();
    expect(base.media.chunk).not.toHaveBeenCalled();
    expect(base.provider.process).not.toHaveBeenCalled();
  });

  it('reports adapter failures without letting a reporting error suppress durable failure', async () => {
    const onProcessingError = vi.fn(() => {
      throw new Error('logger unavailable');
    });
    const { sdk, provider } = fixture({ onProcessingError });
    provider.process.mockRejectedValue(new Error('Provider returned HTTP 401'));
    const job = await sdk.submit('alice', request);
    await sdk.runNext();
    expect(onProcessingError).toHaveBeenCalledWith(job.id, expect.any(Error));
    expect((await sdk.get('alice', job.id)).status).toBe('failed');
  });

  it('records the causal provider failure after a lower-index sibling rejects on cancellation', async () => {
    const cause = new MediaError('provider_rejected', 'Provider rejected the media', false);
    const onProcessingError = vi.fn();
    const base = fixture();
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const process = vi
      .fn<SdkOptions['provider']['process']>()
      .mockImplementationOnce(
        (_artifact, _request, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Canceled sibling', 'AbortError')),
              { once: true },
            );
            started();
          }),
      )
      .mockImplementationOnce(async () => {
        await firstStarted;
        throw cause;
      });
    const sdk = new MediaSdk({
      sources: base.sources,
      media: base.media,
      provider: { ...base.provider, process },
      chunkConcurrency: 2,
      onProcessingError,
    });
    const job = await sdk.submit('alice', request);
    await sdk.runNext();
    expect(onProcessingError).toHaveBeenCalledWith(job.id, cause);
    expect((await sdk.get('alice', job.id)).error).toEqual({
      code: 'provider_rejected',
      message: 'Provider rejected the media',
      retryable: false,
    });
    expect(base.media.cleanup).toHaveBeenCalledOnce();
  });
  it('pins model, processes ordered chunks, offsets timestamps and strips internal persistence data', async () => {
    const { sdk, provider, media } = fixture();
    const job = await sdk.submit('alice', request);
    expect(job.request.model).toBe('test-model');
    expect(job).not.toHaveProperty('ownerId');
    expect(await sdk.runNext()).toBe(true);
    const completed = await sdk.get('alice', job.id);
    expect(completed.status).toBe('completed');
    expect(completed.completedChunks).toBe(2);
    expect(completed.result?.segments.map((segment) => segment.startMs)).toEqual([0, 1000]);
    expect(provider.process).toHaveBeenCalledTimes(2);
    expect(media.cleanup).toHaveBeenCalledOnce();
    expect(await sdk.runNext()).toBe(false);
    expect(await sdk.list('alice')).toHaveLength(1);
    expect(await sdk.list('bob')).toEqual([]);
    await expect(sdk.get('bob', job.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(sdk.retry('alice', job.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('atomically deduplicates concurrent submissions and rejects conflicting reuse', async () => {
    const { sdk } = fixture();
    const jobs = await Promise.all(
      Array.from({ length: 20 }, () => sdk.submit('alice', request, 'same-key')),
    );
    expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
    await expect(
      sdk.submit('alice', { ...request, targetLanguage: 'fr' }, 'same-key'),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect((await sdk.submit('bob', request, 'same-key')).id).not.toBe(jobs[0]!.id);
    await expect(sdk.submit('', request)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(sdk.submit('alice', request, '')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(sdk.list('alice', { limit: 0 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('retries only failed chunks and rematerializes the source on a fresh attempt', async () => {
    const { sdk, provider, sources } = fixture({ chunkConcurrency: 1 });
    provider.process
      .mockResolvedValueOnce(output)
      .mockRejectedValueOnce(new Error('secret provider details'));
    const job = await sdk.submit('alice', request);
    await sdk.runNext();
    expect((await sdk.get('alice', job.id)).status).toBe('failed');
    expect((await sdk.get('alice', job.id)).error?.message).not.toContain('secret');
    await expect(sdk.retry('bob', job.id)).rejects.toMatchObject({ code: 'not_found' });
    await sdk.retry('alice', job.id);
    await sdk.runNext();
    expect((await sdk.get('alice', job.id)).status).toBe('completed');
    expect(provider.process).toHaveBeenCalledTimes(3);
    expect(sources.materialize).toHaveBeenCalledTimes(2);
  });

  it('rejects resumed checkpoints if source bytes change', async () => {
    const { sdk, provider, sources } = fixture({ chunkConcurrency: 1 });
    provider.process.mockResolvedValueOnce(output).mockRejectedValueOnce(new Error('interrupted'));
    const job = await sdk.submit('alice', request);
    await sdk.runNext();
    await sdk.retry('alice', job.id);
    sources.materialize.mockResolvedValue({
      uri: 'input',
      fileName: 'input',
      fingerprint: 'content-v2',
    });
    await sdk.runNext();
    expect((await sdk.get('alice', job.id)).error?.code).toBe('source_changed');
    expect(provider.process).toHaveBeenCalledTimes(2);
  });

  it('translates merged text once and reports unsupported translation', async () => {
    const first = fixture();
    const job = await first.sdk.submit('alice', { ...request, targetLanguage: 'fr' });
    await first.sdk.runNext();
    expect((await first.sdk.get('alice', job.id)).result?.translatedText).toBe('bonjour');
    expect(first.provider.translate).toHaveBeenCalledOnce();
    const second = fixture({
      provider: {
        resolveModel: () => 'model',
        chunkDurationMs: () => 1000,
        process: async () => output,
      },
    });
    const bad = await second.sdk.submit('alice', { ...request, targetLanguage: 'fr' });
    await second.sdk.runNext();
    expect((await second.sdk.get('alice', bad.id)).error?.code).toBe('unsupported_translation');
  });

  it('preserves successful completion when cleanup fails and reports the cleanup failure', async () => {
    const onCleanupError = vi.fn();
    const { sdk, media } = fixture({ onCleanupError });
    media.cleanup.mockRejectedValue(new Error('cleanup failed'));
    const job = await sdk.submit('alice', request);
    await sdk.runNext();
    expect((await sdk.get('alice', job.id)).status).toBe('completed');
    expect(onCleanupError).toHaveBeenCalledOnce();
  });

  it('validates media and provider output before persisting results', async () => {
    const first = fixture();
    first.media.inspect.mockResolvedValue({ durationMs: 1000, hasAudio: false, hasVideo: true });
    const firstJob = await first.sdk.submit('alice', request);
    await first.sdk.runNext();
    expect((await first.sdk.get('alice', firstJob.id)).error?.code).toBe('invalid_media');
    const second = fixture();
    second.provider.process.mockResolvedValue({
      ...output,
      segments: [{ startMs: -1, endMs: 1, text: 'bad' }],
    });
    const secondJob = await second.sdk.submit('alice', request);
    await second.sdk.runNext();
    expect((await second.sdk.get('alice', secondJob.id)).status).toBe('failed');
    expect((await second.sdk.get('alice', secondJob.id)).completedChunks).toBe(0);
  });

  it('stops claiming on shutdown and leaves interrupted jobs recoverable', async () => {
    const controller = new AbortController();
    const { sdk, provider } = fixture();
    const job = await sdk.submit('alice', request);
    provider.process.mockImplementation(async () => {
      controller.abort();
      return output;
    });
    await sdk.runNext(controller.signal);
    expect((await sdk.get('alice', job.id)).status).toBe('running');
    expect(await sdk.runNext(controller.signal)).toBe(false);
  });

  it('heartbeats long provider calls and aborts on lease loss', async () => {
    vi.useFakeTimers();
    try {
      const { sdk, repository, provider } = fixture({ leaseMs: 300, heartbeatMs: 100 });
      const job = await sdk.submit('alice', request);
      let observed: AbortSignal | undefined;
      provider.process.mockImplementation(
        async (_artifact: unknown, _request: unknown, context: AdapterContext) => {
          observed = context.signal;
          await new Promise<void>((resolve) =>
            context.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          return output;
        },
      );
      vi.spyOn(repository, 'heartbeat').mockRejectedValue(new LeaseLostError());
      const running = sdk.runNext();
      await vi.advanceTimersByTimeAsync(100);
      await running;
      expect(observed?.aborted).toBe(true);
      expect((await sdk.get('alice', job.id)).status).toBe('running');
      expect((await sdk.get('alice', job.id)).completedChunks).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('repository concurrency and fencing', () => {
  it('claims once, reclaims expired work and rejects every stale mutation', async () => {
    let time = 1000;
    const { sdk, repository } = fixture({ clock: () => time });
    const job = await sdk.submit('alice', request);
    const claims = await Promise.all([repository.claim(time, 100), repository.claim(time, 100)]);
    const first = claims.find(Boolean)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    await repository.savePlan(
      job.id,
      first.token,
      [{ index: 0, startMs: 0, endMs: 1000 }],
      'hash',
      time,
    );
    await repository.saveChunk(job.id, first.token, 0, output, time);
    time = 1101;
    const second = (await repository.claim(time, 100))!;
    expect(second.job.chunks['0']).toEqual(output);
    expect(second.token).not.toBe(first.token);
    await repository.savePlan(
      job.id,
      second.token,
      [{ endMs: 1000, index: 0, startMs: 0 }],
      'hash',
      time,
    );
    await expect(repository.heartbeat(job.id, first.token, time, 100)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await expect(repository.savePlan(job.id, first.token, [], 'hash', time)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await expect(repository.saveChunk(job.id, first.token, 0, output, time)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await expect(
      repository.complete(
        job.id,
        first.token,
        aggregate(second.job.plan!, second.job.chunks, second.job.request),
        time,
      ),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await expect(
      repository.fail(job.id, first.token, { code: 'bad', message: 'bad', retryable: false }, time),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await repository.heartbeat(job.id, second.token, time, 100);
    await repository.complete(
      job.id,
      second.token,
      aggregate(second.job.plan!, second.job.chunks, second.job.request),
      time,
    );
    expect((await sdk.get('alice', job.id)).status).toBe('completed');
  });

  it('fences cached completion and refuses another owner’s retained result', async () => {
    let time = 1000;
    const { sdk, repository } = fixture({ clock: () => time });
    const bobJob = await sdk.submit('bob', request);
    await sdk.runNext();
    const bobResult = await sdk.getResult('bob', bobJob.id);
    expect(await repository.findResults('alice', { fingerprint: 'content-v1' }, 10)).toEqual([]);
    expect(await repository.findResults('bob', { mediaId: 'content-v1' }, 10)).toHaveLength(1);
    const job = await sdk.submit('alice', request);
    const first = (await repository.claim(time, 100))!;
    await expect(
      repository.completeFromCache(job.id, first.token, bobResult, time),
    ).rejects.toMatchObject({ code: 'not_found' });
    time = 1101;
    const second = (await repository.claim(time, 100))!;
    await expect(
      repository.completeFromCache(job.id, first.token, bobResult, time),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await repository.fail(job.id, second.token, { code: 'x', message: 'x', retryable: true }, time);
    expect((await sdk.get('alice', job.id)).cachedFrom).toBeUndefined();
  });

  it('rejects missing chunks and duplicate IDs, and never exposes mutable storage references', async () => {
    const { sdk, repository } = fixture();
    const job = await sdk.submit('alice', request);
    const lease = (await repository.claim(Date.now(), 10000))!;
    await expect(repository.enqueue(lease.job)).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      repository.saveChunk(job.id, lease.token, 0, output, Date.now()),
    ).rejects.toMatchObject({ code: 'invalid_chunk' });
    await expect(
      repository.complete(job.id, lease.token, aggregate([], {}, lease.job.request), Date.now()),
    ).rejects.toMatchObject({ code: 'incomplete_job' });
    lease.job.request.source.uri = 'changed';
    expect((await repository.get('alice', job.id))?.request.source.uri).toBe(request.source.uri);
    expect(await repository.list('alice', { limit: 10, status: 'failed' })).toEqual([]);
    await expect(repository.retry('alice', 'missing', Date.now())).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('planning and aggregation', () => {
  it('uses non-overlapping ordered ranges and bounds total work', () => {
    expect(planChunks(2500, 1000)).toEqual([
      { index: 0, startMs: 0, endMs: 1000 },
      { index: 1, startMs: 1000, endMs: 2000 },
      { index: 2, startMs: 2000, endMs: 2500 },
    ]);
    expect(() => planChunks(0, 1000)).toThrow(MediaError);
    expect(() => planChunks(1000, 0)).toThrow(MediaError);
    expect(() => planChunks(1000, 1, 10)).toThrow(MediaError);
    expect(() => fixture({ chunkConcurrency: 0 })).toThrow(MediaError);
    expect(() => fixture({ leaseMs: 1, heartbeatMs: 2 })).toThrow(MediaError);
  });
  it('orders understanding chunks and offsets time ranges', () => {
    const plan = planChunks(2000, 1000).reverse();
    const result = aggregate(
      plan,
      {
        '0': { ...output, text: 'first', timeRanges: [{ startMs: 1, endMs: 10, label: 'one' }] },
        '1': { ...output, text: 'second', timeRanges: [{ startMs: 1, endMs: 10 }] },
      },
      {
        ...request,
        kind: 'understanding',
        provider: 'google-gemini',
        prompt: 'describe',
        model: 'model',
      },
    );
    expect(result.text).toBe('first\n\nsecond');
    expect(result.timeRanges[1]?.startMs).toBe(1001);
    expect(() => aggregate(plan, {}, request)).toThrow(MediaError);
  });
  it('retains ASR provenance across an audio chunk followed by a silent chunk', () => {
    const result = aggregate(
      planChunks(2000, 1000),
      {
        '0': {
          ...output,
          provenance: {
            transcription: { provider: 'codex', protocol: 'realtime-v3', model: null },
            frameIntervalMs: 5000,
          },
        },
        '1': { ...output, provenance: { frameIntervalMs: 5000 } },
      },
      {
        ...request,
        kind: 'understanding',
        provider: 'claude-code',
        prompt: 'describe',
        model: 'sonnet',
      },
    );
    expect(result.provider).toBe('claude-code');
    expect(result.provenance).toEqual({
      transcription: { provider: 'codex', protocol: 'realtime-v3', model: null },
      frameIntervalMs: 5000,
    });
  });

  it('rejects incompatible frame intervals and transcription identities across checkpoints', () => {
    const plan = planChunks(2000, 1000);
    const modelRequest = { ...request, model: 'test' };
    const transcription = { provider: 'codex', protocol: 'realtime-v3', model: null } as const;
    const first = { ...output, provenance: { frameIntervalMs: 5000, transcription } };
    const second = { ...output, provenance: { frameIntervalMs: 1000 } };
    expect(() => aggregate(plan, { 0: first, 1: second }, modelRequest)).toThrowError(
      expect.objectContaining({
        code: 'inconsistent_provenance',
        message: expect.stringContaining('frameIntervalMs'),
      }),
    );
    // A persisted checkpoint can contain an identity from an older protocol version.
    const older = {
      ...output,
      provenance: { transcription: { ...transcription, protocol: 'realtime-v2' } },
    } as unknown as ChunkOutput;
    expect(() => aggregate(plan, { 0: first, 1: older }, modelRequest)).toThrowError(
      expect.objectContaining({
        code: 'inconsistent_provenance',
        message: expect.stringContaining('transcription'),
      }),
    );
    expect(
      aggregate(plan, { 0: first, 1: structuredClone(first) }, modelRequest).provenance,
    ).toEqual(first.provenance);
  });
});
