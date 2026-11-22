import { describe, expect, it, vi } from 'vitest';
import { jobSchema, type JobView, type MediaRequest } from '@media-ingest/contracts';
import {
  jobView,
  MediaError,
  MediaSdk,
  MemoryJobRepository,
  sanitizeDetails,
  type ChunkOutput,
  type SdkOptions,
} from '../src/index.js';

const request: MediaRequest = {
  kind: 'transcription',
  source: { kind: 'http', uri: 'https://example.test/media' },
  provider: 'google-gemini',
};
const output: ChunkOutput = {
  text: 'hello',
  segments: [{ startMs: 0, endMs: 500, text: 'hello' }],
  timeRanges: [],
  detectedLanguage: 'en',
};

function fixture(overrides: Partial<SdkOptions> = {}) {
  const repository = new MemoryJobRepository();
  const saveStage = vi.spyOn(repository, 'saveStage');
  const sources = {
    resolve: vi.fn(async (source: MediaRequest['source']) => ({
      source,
      fileName: 'input',
      metadata: {},
    })),
    materialize: vi.fn(async () => ({ uri: 'input', fileName: 'input', fingerprint: 'v1' })),
  };
  const media = {
    inspect: vi.fn(async () => ({ durationMs: 2000, hasAudio: true, hasVideo: false })),
    chunk: vi.fn(async () => ({ uri: 'chunk', fileName: 'chunk', fingerprint: 'c1' })),
    loudness: vi.fn(async () => ({ frameMs: 100, levels: new Float64Array(20).fill(-20) })),
    cleanup: vi.fn(async () => {}),
  };
  const provider = {
    resolveModel: vi.fn(() => 'gemini-test'),
    chunkDurationMs: vi.fn(() => 1000),
    process: vi.fn(async () => structuredClone(output)),
    synthesize: vi.fn(async () => ({ text: 'whole', timeRanges: [] })),
    translate: vi.fn(async () => 'привет'),
    alternatives: vi.fn((): MediaRequest['provider'][] => ['openai', 'google-speech']),
  };
  const sdk = new MediaSdk({ repository, sources, media, provider, ...overrides });
  return { sdk, repository, saveStage, sources, media, provider };
}

describe('job stage and next steps', () => {
  it('reports queued, running and completed stages with poll hints only while active', async () => {
    const { sdk, provider, saveStage } = fixture({ chunkConcurrency: 1 });
    const queued = await sdk.submit('alice', { ...request, targetLanguage: 'ru' });
    expect(queued.stage).toBe('queued');
    expect(queued.nextSteps).toEqual([
      {
        operation: 'get',
        input: { id: queued.id },
        reason: expect.stringContaining('queued'),
        pollAfterSeconds: 5,
      },
    ]);
    const seen: JobView[] = [];
    provider.process.mockImplementation(async () => {
      seen.push(await sdk.get('alice', queued.id));
      return structuredClone(output);
    });
    await sdk.runNext();
    expect(seen[0]).toMatchObject({ status: 'running', stage: 'processing' });
    const total = seen[0]!.totalChunks;
    expect(total).toBeGreaterThan(1);
    expect(seen[0]!.nextSteps).toEqual([
      expect.objectContaining({ operation: 'get', pollAfterSeconds: 30 }),
    ]);
    expect(seen[1]!.nextSteps![0]!.reason).toContain(`(1/${total} chunks done)`);
    // A few writes per job at transitions, independent of the number of chunks.
    expect(saveStage.mock.calls.map((call) => call[2])).toEqual([
      'downloading',
      'inspecting',
      'planning',
      'translating',
    ]);
    const completed = await sdk.get('alice', queued.id);
    expect(completed).toMatchObject({ status: 'completed', stage: 'completed' });
    expect(completed).not.toHaveProperty('nextSteps');
    expect(jobSchema.parse(completed)).toEqual(completed);
  });

  it('records synthesis as a stage for multi-chunk understanding', async () => {
    const { sdk, saveStage } = fixture();
    await sdk.submit('alice', { ...request, kind: 'understanding', prompt: 'Summarize' });
    await sdk.runNext();
    expect(saveStage.mock.calls.map((call) => call[2])).toContain('synthesizing');
  });

  it('suggests retry and a configured alternative for a provider failure', async () => {
    const { sdk, provider } = fixture();
    provider.process.mockResolvedValueOnce(structuredClone(output)).mockRejectedValueOnce(
      new MediaError('provider_invalid_output', 'google-gemini returned unusable output', true, {
        provider: 'google-gemini',
        finishReason: 'STOP',
        parseErrorPosition: 11848,
      }),
    );
    const job = await sdk.submit('alice', request, 'key');
    await sdk.runNext();
    const failed = await sdk.get('alice', job.id);
    expect(failed.stage).toBe('failed');
    expect(failed).not.toHaveProperty('nextSteps');
    expect(failed.error).toMatchObject({
      code: 'provider_invalid_output',
      retryable: true,
      details: {
        stage: 'processing',
        provider: 'google-gemini',
        model: 'gemini-test',
        attempt: 1,
        chunkIndex: 1,
        chunkStartMs: expect.any(Number),
        chunkEndMs: expect.any(Number),
        finishReason: 'STOP',
        parseErrorPosition: 11848,
      },
    });
    const { model: _model, ...withoutModel } = failed.request;
    expect(failed.error?.nextSteps).toEqual([
      {
        operation: 'retry',
        input: { id: job.id },
        reason: expect.stringContaining('reuses 1 completed chunks'),
      },
      {
        operation: 'submit',
        input: { request: { ...withoutModel, provider: 'openai' } },
        reason: expect.stringContaining('openai'),
      },
    ]);
    // Retrying clears the error and its suggestions; the job polls again.
    const retried = await sdk.retry('alice', job.id);
    expect(retried).toMatchObject({ status: 'queued', stage: 'queued', error: null });
    expect(retried.nextSteps?.[0]?.operation).toBe('get');
  });

  it('points at the input for source failures and a fresh submission for changed sources', async () => {
    const { sdk, media, sources } = fixture();
    media.inspect.mockResolvedValueOnce({ durationMs: 2000, hasAudio: false, hasVideo: true });
    const silent = await sdk.submit('alice', request);
    await sdk.runNext();
    expect((await sdk.get('alice', silent.id)).error).toMatchObject({
      code: 'invalid_media',
      details: { stage: 'inspecting', attempt: 1 },
      nextSteps: [{ operation: 'resolve', input: { source: request.source } }],
    });
    sources.materialize.mockRejectedValueOnce(
      new MediaError('source_changed', 'Source bytes changed'),
    );
    const changed = await sdk.submit('alice', { ...request, force: true });
    await sdk.runNext();
    const view = await sdk.get('alice', changed.id);
    expect(view.error?.details).not.toHaveProperty('provider');
    expect(view.error?.nextSteps).toEqual([
      expect.objectContaining({ operation: 'submit', input: { request: view.request } }),
    ]);
  });

  it('offers retry before an alternative provider for a truncated chunk', async () => {
    const { sdk, provider } = fixture({ chunkConcurrency: 1 });
    provider.process.mockResolvedValueOnce(structuredClone(output)).mockRejectedValueOnce(
      new MediaError('provider_output_truncated', 'Gemini reached its output token limit', true, {
        finishReason: 'MAX_TOKENS',
        outputTokens: 29_700,
        calls: 3,
      }),
    );
    const job = await sdk.submit('alice', request);
    await sdk.runNext();
    const failed = await sdk.get('alice', job.id);
    expect(failed.error?.nextSteps?.map((step) => [step.operation, step.input])).toEqual([
      ['retry', { id: job.id }],
      ['submit', { request: expect.objectContaining({ provider: 'openai' }) }],
    ]);
    expect(failed.error?.nextSteps?.[0]?.reason).toContain('reuses 1 completed chunks');
  });

  it('never suggests an alternative the provider does not offer', async () => {
    const { sdk, provider } = fixture();
    provider.alternatives.mockReturnValue([]);
    provider.process.mockRejectedValue(
      new MediaError('provider_blocked', 'Gemini blocked the request (SAFETY)', false),
    );
    const job = await sdk.submit('alice', request);
    await sdk.runNext();
    const failed = await sdk.get('alice', job.id);
    expect(failed.error?.code).toBe('provider_blocked');
    expect(failed.error).not.toHaveProperty('nextSteps');
  });

  it('derives a stage for records written before stages existed and drops stored suggestions', () => {
    const base = {
      id: '00000000-0000-4000-8000-000000000000',
      request,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      attempt: 1,
      result: null,
      error: null,
      completedChunks: 0,
      totalChunks: 0,
    };
    expect(jobView({ ...base, status: 'running' }).stage).toBe('resolving');
    expect(jobView({ ...base, status: 'running', totalChunks: 3 }).stage).toBe('processing');
    const failed = jobView({
      ...base,
      status: 'failed',
      stage: 'processing',
      nextSteps: [{ operation: 'info', input: {}, reason: 'stale' }],
      error: { code: 'lease_lost', message: 'lost', retryable: true },
    });
    expect(failed.stage).toBe('failed');
    expect(failed).not.toHaveProperty('nextSteps');
    expect(failed.error?.nextSteps?.map((step) => step.operation)).toEqual(['retry']);
  });

  it('keeps only flat primitive details and never URLs', () => {
    expect(
      sanitizeDetails({
        provider: 'openai',
        httpStatus: 503,
        ok: false,
        none: null,
        url: 'https://private.example/upload?token=secret',
        nested: { a: 1 },
        infinite: Number.POSITIVE_INFINITY,
        'bad key': 1,
        long: 'x'.repeat(300),
      }),
    ).toEqual({
      provider: 'openai',
      httpStatus: 503,
      ok: false,
      none: null,
      long: 'x'.repeat(200),
    });
    expect(sanitizeDetails({})).toBeUndefined();
  });
});
