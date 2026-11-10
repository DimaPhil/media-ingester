import { describe, expect, it, vi } from 'vitest';
import type { MediaRequest } from '@media-ingest/contracts';
import { MediaSdk, MemoryJobRepository, synthesisParts, synthesizeWhole } from '../src/index.js';
import type { ChunkOutput, ProviderAdapter, SynthesisInput, SynthesisPart } from '../src/index.js';

const understanding: MediaRequest = {
  kind: 'understanding',
  source: { kind: 'http', uri: 'https://example.test/a' },
  provider: 'codex',
  prompt: 'Summarize',
};
const context = { ownerId: 'o', jobId: 'j', attempt: 1, signal: new AbortController().signal };

function fixture(
  durationMs: number,
  synthesize?: ProviderAdapter['synthesize'],
  request: MediaRequest = understanding,
) {
  let call = 0;
  const provider: ProviderAdapter = {
    resolveModel: () => 'model',
    chunkDurationMs: () => 1000,
    process: vi.fn(async (): Promise<ChunkOutput> => ({
      text: `part ${call++}`,
      segments: [],
      timeRanges: [{ startMs: 100, endMs: 200, label: 'event' }],
      detectedLanguage: null,
    })),
    translate: vi.fn(async (text: string) => `fr:${text}`),
    ...(synthesize ? { synthesize } : {}),
  };
  const sdk = new MediaSdk({
    repository: new MemoryJobRepository(),
    sources: {
      resolve: async (source) => ({ source, fileName: 'input', metadata: {} }),
      materialize: async () => ({ uri: 'input', fileName: 'input', fingerprint: 'v1' }),
    },
    media: {
      inspect: async () => ({ durationMs, hasAudio: false, hasVideo: true }),
      chunk: async () => ({ uri: 'chunk', fileName: 'chunk', fingerprint: 'c' }),
      cleanup: async () => {},
    },
    provider,
  });
  return {
    provider,
    async run(overrides: Partial<MediaRequest> = {}) {
      const job = await sdk.submit('alice', { ...request, ...overrides } as MediaRequest);
      await sdk.runNext();
      return sdk.get('alice', job.id);
    },
  };
}

describe('whole-media synthesis', () => {
  it('answers multi-chunk understanding from absolute span analyses, before translation', async () => {
    const synthesize = vi.fn(async (input: SynthesisInput) => ({
      text: `whole of ${input.parts.length}`,
      timeRanges: [{ startMs: 2_500, endMs: 2_600, label: 'peak' }],
    }));
    const { run, provider } = fixture(3_000, synthesize);
    const job = await run({ targetLanguage: 'fr' });
    expect(job.status).toBe('completed');
    expect(synthesize).toHaveBeenCalledOnce();
    const input = synthesize.mock.calls[0]![0];
    expect(input).toMatchObject({ durationMs: 3_000, startMs: 0, endMs: 3_000, final: true });
    expect(input.parts.map((part) => [part.startMs, part.endMs, part.text])).toEqual([
      [0, 1_000, 'part 0'],
      [1_000, 2_000, 'part 1'],
      [2_000, 3_000, 'part 2'],
    ]);
    expect(input.parts[1]!.timeRanges).toEqual([{ startMs: 1_100, endMs: 1_200, label: 'event' }]);
    expect(job.result?.text).toBe('whole of 3');
    expect(job.result?.timeRanges).toEqual([{ startMs: 2_500, endMs: 2_600, label: 'peak' }]);
    expect(provider.translate).toHaveBeenCalledWith(
      'whole of 3',
      expect.anything(),
      expect.anything(),
    );
    expect(job.result?.translatedText).toBe('fr:whole of 3');
  });

  it('skips single-chunk media and transcription, and keeps concatenation without support', async () => {
    const synthesize = vi.fn(async () => ({ text: 'never', timeRanges: [] }));
    expect((await fixture(900, synthesize).run()).result?.text).toBe('part 0');
    const transcription: MediaRequest = { ...understanding, kind: 'transcription' } as never;
    delete (transcription as { prompt?: string }).prompt;
    await fixture(3_000, synthesize, { ...transcription, provider: 'openai' }).run();
    expect(synthesize).not.toHaveBeenCalled();
    const unsupported = fixture(2_000, async () => null);
    expect((await unsupported.run()).result?.text).toBe('part 0\n\npart 1');
    expect((await fixture(2_000).run()).result?.text).toBe('part 0\n\npart 1');
  });

  it('fails the job when synthesis returns timestamps outside the media', async () => {
    const job = await fixture(2_000, async () => ({
      text: 'answer',
      timeRanges: [{ startMs: 1_900, endMs: 2_100 }],
    })).run();
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('invalid_provider_output');
  });

  it('reduces inputs over the budget span by span, each level shrinking', async () => {
    const parts: SynthesisPart[] = Array.from({ length: 5 }, (_, index) => ({
      startMs: index * 1000,
      endMs: (index + 1) * 1000,
      text: 'x'.repeat(40),
      timeRanges: [],
    }));
    const calls: SynthesisInput[] = [];
    const provider: ProviderAdapter = {
      resolveModel: () => 'm',
      chunkDurationMs: () => 1000,
      process: async () => ({ text: '', segments: [], timeRanges: [], detectedLanguage: null }),
      synthesize: async (input) => {
        calls.push(input);
        return {
          text: input.final ? 'final' : `span ${input.startMs}-${input.endMs}`,
          timeRanges: [{ startMs: input.startMs, endMs: input.startMs }],
        };
      },
    };
    const whole = await synthesizeWhole(provider, parts, 5000, understanding, context, 100);
    expect(whole?.text).toBe('final');
    expect(
      calls.map((input) => [input.final, input.startMs, input.endMs, input.parts.length]),
    ).toEqual([
      [false, 0, 2000, 2],
      [false, 2000, 5000, 3],
      [true, 0, 5000, 2],
    ]);
    expect(calls[2]!.parts[1]!.text).toBe('span 2000-5000');
  });

  it('reports missing chunks and rejects empty synthesized text', async () => {
    expect(() => synthesisParts([{ index: 0, startMs: 0, endMs: 1 }], {})).toThrow('missing');
    const provider: ProviderAdapter = {
      resolveModel: () => 'm',
      chunkDurationMs: () => 1000,
      process: async () => ({ text: '', segments: [], timeRanges: [], detectedLanguage: null }),
      synthesize: async () => ({ text: '  ', timeRanges: [] }),
    };
    await expect(synthesizeWhole(provider, [], 1000, understanding, context)).rejects.toMatchObject(
      { code: 'invalid_provider_output' },
    );
  });
});
