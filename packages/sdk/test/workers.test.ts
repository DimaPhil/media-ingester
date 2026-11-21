import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRequest } from '@media-ingest/contracts';
import { LeaseLostError, MediaSdk, MemoryJobRepository, WorkSignal } from '../src/index.js';
import type { ChunkOutput, JobRepository, WorkerLoopOptions } from '../src/index.js';

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
const IDLE_POLL_MS = 30 * 60_000;

function fixture(repository: JobRepository = new MemoryJobRepository()) {
  const process = vi.fn(async () => structuredClone(output));
  const sdk = new MediaSdk({
    repository,
    sources: {
      resolve: async (source) => ({ source, fileName: 'input', metadata: {} }),
      materialize: async () => ({ uri: 'input', fileName: 'input', fingerprint: 'content-v1' }),
    },
    media: {
      inspect: async () => ({ durationMs: 1000, hasAudio: true, hasVideo: true }),
      chunk: async () => ({ uri: 'chunk', fileName: 'chunk', fingerprint: 'chunk-v1' }),
      cleanup: async () => {},
    },
    provider: {
      resolveModel: () => 'test-model',
      chunkDurationMs: () => 1000,
      process,
    },
    leaseMs: 60_000,
  });
  const claim = vi.spyOn(repository, 'claim');
  return { sdk, repository, claim, process };
}

function start(sdk: MediaSdk, options: Partial<WorkerLoopOptions> = {}) {
  const abort = new AbortController();
  const done = sdk.runWorkers({
    workers: 2,
    idlePollMs: IDLE_POLL_MS,
    signal: abort.signal,
    ...options,
  });
  return {
    async stop() {
      abort.abort();
      await done;
    },
  };
}

/** Lets in-process work run without moving the fake clock. */
async function settle() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}

describe('worker loops', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('looks for work once at startup and then not before the fallback poll', async () => {
    const { sdk, claim } = fixture();
    const onIdle = vi.fn();
    const loops = start(sdk, { onIdle });
    await settle();
    expect(claim).toHaveBeenCalledTimes(2);
    expect(onIdle).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS - 1);
    expect(claim).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    // Both workers share one fallback timer, so they wake the database together.
    expect(claim).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(3 * IDLE_POLL_MS);
    await settle();
    expect(claim).toHaveBeenCalledTimes(10);
    await loops.stop();
  });

  it('wakes an idle worker as soon as a job is submitted and drains the queue', async () => {
    const { sdk, claim } = fixture();
    const loops = start(sdk);
    await settle();
    const startedAt = Date.now();
    const first = await sdk.submit('alice', request);
    const second = await sdk.submit('alice', { ...request, force: true });
    await settle();
    expect((await sdk.get('alice', first.id)).status).toBe('completed');
    expect((await sdk.get('alice', second.id)).status).toBe('completed');
    expect(Date.now() - startedAt).toBeLessThan(1000);
    const claims = claim.mock.calls.length;
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS - 1000);
    expect(claim).toHaveBeenCalledTimes(claims);
    await loops.stop();
  });

  it('wakes an idle worker when a failed job is retried', async () => {
    const { sdk, process } = fixture();
    process.mockRejectedValueOnce(new Error('transient'));
    const loops = start(sdk);
    const job = await sdk.submit('alice', request);
    await settle();
    expect((await sdk.get('alice', job.id)).status).toBe('failed');
    await sdk.retry('alice', job.id);
    await settle();
    expect((await sdk.get('alice', job.id)).status).toBe('completed');
    await loops.stop();
  });

  it('recovers work queued by another process on the fallback poll', async () => {
    const repository = new MemoryJobRepository();
    const { sdk } = fixture(repository);
    const other = fixture(repository);
    const loops = start(sdk);
    await settle();
    const job = await other.sdk.submit('alice', request);
    await settle();
    expect((await sdk.get('alice', job.id)).status).toBe('queued');
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS);
    await settle();
    expect((await sdk.get('alice', job.id)).status).toBe('completed');
    await loops.stop();
  });

  it('reclaims a job whose lease was lost once the lease expires', async () => {
    const { sdk, repository } = fixture();
    const saveChunk = repository.saveChunk.bind(repository);
    vi.spyOn(repository, 'saveChunk')
      .mockRejectedValueOnce(new LeaseLostError())
      .mockImplementation(saveChunk);
    const loops = start(sdk, { workers: 1 });
    const job = await sdk.submit('alice', request);
    await settle();
    expect((await sdk.get('alice', job.id)).status).toBe('running');
    await vi.advanceTimersByTimeAsync(61_000);
    await settle();
    const recovered = await sdk.get('alice', job.id);
    expect(recovered.status).toBe('completed');
    expect(recovered.attempt).toBe(2);
    await loops.stop();
  });

  it('backs off after repository errors and keeps running', async () => {
    const { sdk, claim } = fixture();
    claim.mockRejectedValue(new Error('database unavailable'));
    const onError = vi.fn();
    const loops = start(sdk, { workers: 1, onError, onIdle: () => {} });
    await settle();
    expect(claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(claim).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(claim).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(claim).toHaveBeenCalledTimes(3);
    // The delay is capped at one minute.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(claim.mock.calls.length).toBeLessThanOrEqual(3 + 4 + 10);
    expect(onError).toHaveBeenCalled();
    claim.mockRestore();
    await vi.advanceTimersByTimeAsync(60_000);
    const job = await sdk.submit('alice', request);
    await settle();
    expect((await sdk.get('alice', job.id)).status).toBe('completed');
    await loops.stop();
  });

  it('keeps running when host callbacks throw', async () => {
    const { sdk } = fixture();
    const loops = start(sdk, {
      onIdle: () => {
        throw new Error('callback');
      },
    });
    await settle();
    const job = await sdk.submit('alice', request);
    await settle();
    expect((await sdk.get('alice', job.id)).status).toBe('completed');
    await loops.stop();
  });

  it('rejects invalid loop configuration', async () => {
    const { sdk } = fixture();
    const signal = new AbortController().signal;
    await expect(sdk.runWorkers({ workers: 0, idlePollMs: 1000, signal })).rejects.toThrow(
      'Invalid worker count',
    );
    await expect(sdk.runWorkers({ workers: 1, idlePollMs: 0, signal })).rejects.toThrow(
      'idle poll interval',
    );
  });
});

describe('work signal', () => {
  it('keeps a notification that arrives before the wait starts', async () => {
    const work = new WorkSignal();
    const seen = work.version;
    work.notify();
    await work.wait(seen, Infinity);
    const abort = new AbortController();
    const waiting = work.wait(work.version, Infinity, abort.signal);
    abort.abort();
    await waiting;
    await work.wait(work.version, Infinity, abort.signal);
  });
});
