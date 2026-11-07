import { describe, expect, it, vi } from 'vitest';
import type { MediaRequest } from '@media-ingest/contracts';
import {
  aggregate,
  MediaSdk,
  MemoryJobRepository,
  planChunks,
  stitchOverlap,
} from '../src/index.js';
import type { Chunk, ChunkOutput, LoudnessProfile } from '../src/index.js';

const frameMs = 20;
function profile(durationMs: number, level: (ms: number) => number): LoudnessProfile {
  return {
    frameMs,
    levels: Array.from({ length: Math.ceil(durationMs / frameMs) }, (_, index) =>
      level(index * frameMs),
    ),
  };
}
const between = (ms: number, from: number, to: number) => ms >= from && ms < to;

/** Every chunk fits the provider limit and keep ranges tile the media exactly once. */
function expectWellFormed(plan: Chunk[], durationMs: number, limitMs: number) {
  let owned = 0;
  plan.forEach((chunk, index) => {
    expect(chunk.index).toBe(index);
    expect(chunk.endMs - chunk.startMs).toBeLessThanOrEqual(limitMs);
    expect(chunk.endMs).toBeGreaterThan(chunk.startMs);
    const keepStart = chunk.keepStartMs ?? chunk.startMs;
    const keepEnd = chunk.keepEndMs ?? chunk.endMs;
    expect(keepStart).toBe(owned);
    expect(keepStart).toBeGreaterThanOrEqual(chunk.startMs);
    expect(keepEnd).toBeLessThanOrEqual(chunk.endMs);
    expect(keepEnd).toBeGreaterThan(keepStart);
    owned = keepEnd;
  });
  expect(owned).toBe(durationMs);
  expect(plan.at(-1)!.endMs).toBe(durationMs);
}

describe('pause-aware chunk planning', () => {
  it('keeps the fixed grid without a loudness profile or for single-chunk media', () => {
    expect(planChunks(2500, 1000)).toEqual([
      { index: 0, startMs: 0, endMs: 1000 },
      { index: 1, startMs: 1000, endMs: 2000 },
      { index: 2, startMs: 2000, endMs: 2500 },
    ]);
    expect(
      planChunks(
        900,
        1000,
        10,
        profile(900, () => -20),
      ),
    ).toEqual([{ index: 0, startMs: 0, endMs: 900 }]);
  });

  it('cuts in the middle of a pause near the chunk limit', () => {
    const loudness = profile(150_000, (ms) =>
      between(ms, 52_000, 52_600) || between(ms, 100_000, 100_400) ? -Infinity : -20,
    );
    const plan = planChunks(150_000, 60_000, 100, loudness);
    expect(plan).toEqual([
      { index: 0, startMs: 0, endMs: 52_300 },
      { index: 1, startMs: 52_300, endMs: 100_200 },
      { index: 2, startMs: 100_200, endMs: 150_000 },
    ]);
    expectWellFormed(plan, 150_000, 60_000);
  });

  it('ignores pauses before the search window and finds pauses relative to a noise floor', () => {
    // A long early pause is too far from the limit; the late one is 14 dB under the speech.
    const loudness = profile(100_000, (ms) =>
      between(ms, 20_000, 25_000) ? -60 : between(ms, 50_000, 50_400) ? -32 : -18,
    );
    const plan = planChunks(100_000, 60_000, 100, loudness);
    expect(plan[0]!.endMs).toBe(50_200);
    expectWellFormed(plan, 100_000, 60_000);
  });

  it('overlaps neighbors and assigns keep ranges where speech never pauses', () => {
    const plan = planChunks(
      150_000,
      60_000,
      100,
      profile(150_000, () => -20),
    );
    expect(plan).toEqual([
      { index: 0, startMs: 0, endMs: 60_000, keepEndMs: 58_000 },
      { index: 1, startMs: 56_000, endMs: 116_000, keepStartMs: 58_000, keepEndMs: 114_000 },
      { index: 2, startMs: 112_000, endMs: 150_000, keepStartMs: 114_000 },
    ]);
    expectWellFormed(plan, 150_000, 60_000);
  });

  it('produces well-formed plans for arbitrary loudness, including short profiles', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 200; run++) {
      const limitMs = [1000, 55_000, 60_000, 600_000][run % 4]!;
      const durationMs = Math.round(limitMs * (1 + random() * 6));
      const levels = Array.from({ length: Math.ceil((durationMs * random()) / frameMs) }, () =>
        random() < 0.05 ? -Infinity : -10 - random() * 50,
      );
      expectWellFormed(
        planChunks(durationMs, limitMs, 10_000, { frameMs, levels }),
        durationMs,
        limitMs,
      );
    }
  });

  it('enforces the chunk limit and rejects invalid frame timing', () => {
    const loudness = profile(10_000, () => -20);
    expect(() => planChunks(10_000, 1000, 3, loudness)).toThrow('chunk limit');
    expect(() => planChunks(10_000, 1000, 100, { frameMs: 0, levels: [] })).toThrow('positive');
  });
});

describe('overlap stitching', () => {
  it('cuts both transcripts at the shared run and drops partial edge words', () => {
    expect(
      stitchOverlap('we will go to the market tomor', 'go to the market tomorrow morning'),
    ).toEqual(['we will go to the market', 'tomorrow morning']);
    expect(stitchOverlap('Hello, World! Fine day', 'hello world fine day today')).toEqual([
      'Hello, World! Fine day',
      'today',
    ]);
  });

  it('keeps both texts whole when no trusted run is shared', () => {
    expect(stitchOverlap('one two three', 'two three four')).toEqual([
      'one two three',
      'two three four',
    ]);
    expect(stitchOverlap('', 'anything at all')).toEqual(['', 'anything at all']);
  });
});

describe('aggregation of overlapped chunks', () => {
  const plan: Chunk[] = [
    { index: 0, startMs: 0, endMs: 60_000, keepEndMs: 58_000 },
    { index: 1, startMs: 56_000, endMs: 100_000, keepStartMs: 58_000 },
  ];
  const outputs: Record<string, ChunkOutput> = {
    '0': {
      text: 'we will go to the market tomor',
      segments: [
        { startMs: 0, endMs: 50_000, text: 'we will' },
        { startMs: 57_000, endMs: 60_000, text: 'go to the market tomor' },
      ],
      timeRanges: [{ startMs: 57_500, endMs: 59_500, label: 'late' }],
      detectedLanguage: 'en',
    },
    '1': {
      text: 'go to the market tomorrow morning',
      segments: [
        { startMs: 0, endMs: 1_500, text: 'go to the' },
        { startMs: 1_500, endMs: 6_000, text: 'market tomorrow morning' },
      ],
      timeRanges: [{ startMs: 1_000, endMs: 3_000, label: 'kept' }],
      detectedLanguage: 'en',
    },
  };

  it('stitches transcription text and keeps each timed item in exactly one chunk', () => {
    const request: MediaRequest = {
      kind: 'transcription',
      source: { kind: 'http', uri: 'https://example.test/a' },
      provider: 'codex',
      model: 'm',
    };
    const result = aggregate(plan, outputs, request);
    expect(result.text).toBe('we will go to the market tomorrow morning');
    expect(result.segments.map((segment) => [segment.startMs, segment.text])).toEqual([
      [0, 'we will'],
      [57_500, 'market tomorrow morning'],
    ]);
    expect(result.timeRanges.map((range) => range.label)).toEqual(['kept']);
  });

  it('leaves understanding prose unstitched', () => {
    const request: MediaRequest = {
      kind: 'understanding',
      source: { kind: 'http', uri: 'https://example.test/a' },
      provider: 'codex',
      model: 'm',
      prompt: 'describe',
    };
    expect(aggregate(plan, outputs, request).text).toBe(
      'we will go to the market tomor\n\ngo to the market tomorrow morning',
    );
  });
});

describe('worker boundary analysis and source selection', () => {
  function fixture(durationMs: number, sourceMedia: 'audio' | 'video') {
    const repository = new MemoryJobRepository();
    const sources = {
      resolve: vi.fn(async (source: MediaRequest['source']) => ({
        source,
        fileName: 'input',
        metadata: {},
      })),
      materialize: vi.fn(async () => ({ uri: 'input', fileName: 'input', fingerprint: 'v1' })),
    };
    const media = {
      inspect: vi.fn(async () => ({ durationMs, hasAudio: true, hasVideo: true })),
      chunk: vi.fn(async () => ({ uri: 'chunk', fileName: 'chunk', fingerprint: 'c' })),
      loudness: vi.fn(async () =>
        // The pause crosses the 2 s limit, so only its eligible part is centered.
        profile(durationMs, (ms) => (between(ms, 1_700, 2_100) ? -Infinity : -20)),
      ),
      cleanup: vi.fn(async () => {}),
    };
    const provider = {
      resolveModel: () => 'model',
      chunkDurationMs: () => 2_000,
      sourceMedia: vi.fn(() => sourceMedia),
      process: vi.fn(async (): Promise<ChunkOutput> => ({
        text: 'words',
        segments: [],
        timeRanges: [],
        detectedLanguage: null,
      })),
    };
    return { sdk: new MediaSdk({ repository, sources, media, provider }), sources, media };
  }
  const request: MediaRequest = {
    kind: 'transcription',
    source: { kind: 'http', uri: 'https://example.test/a' },
    provider: 'openai',
  };

  it('requests audio-only sources and plans boundaries from measured pauses', async () => {
    const { sdk, sources, media } = fixture(3_000, 'audio');
    const job = await sdk.submit('alice', request);
    await sdk.runNext();
    expect(sources.materialize.mock.calls[0]).toHaveLength(3);
    expect((sources.materialize.mock.calls[0] as unknown[])[2]).toEqual({ audioOnly: true });
    expect(media.loudness).toHaveBeenCalledOnce();
    expect(media.chunk.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { index: 0, startMs: 0, endMs: 1_850 },
      { index: 1, startMs: 1_850, endMs: 3_000 },
    ]);
    expect((await sdk.get('alice', job.id)).status).toBe('completed');
  });

  it('keeps full sources for video providers and skips analysis for single-chunk media', async () => {
    const { sdk, sources, media } = fixture(1_500, 'video');
    await sdk.submit('alice', request);
    await sdk.runNext();
    expect((sources.materialize.mock.calls[0] as unknown[])[2]).toBeUndefined();
    expect(media.loudness).not.toHaveBeenCalled();
  });
});
