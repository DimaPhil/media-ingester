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

describe('remote media', () => {
  function remoteFixture(remote: boolean) {
    const repository = new MemoryJobRepository();
    const sources = {
      resolve: vi.fn(async (source: MediaRequest['source']) => ({
        source,
        fileName: 'v',
        metadata: { mediaId: 'abcdefghijk', downloadProvider: 'youtube' },
      })),
      materialize: vi.fn(async () => ({ uri: 'local', fileName: 'v', fingerprint: 'bytes' })),
    };
    const media = {
      inspect: vi.fn(async () => ({ durationMs: 2_500, hasAudio: true, hasVideo: true })),
      chunk: vi.fn(async () => ({ uri: 'chunk', fileName: 'chunk', fingerprint: 'c' })),
      cleanup: vi.fn(async () => {}),
    };
    const processRemote = vi.fn(
      async (_media: unknown, chunk: { index: number }): Promise<ChunkOutput> => ({
        text: `remote ${chunk.index}`,
        segments: [],
        timeRanges: [],
        detectedLanguage: null,
      }),
    );
    const provider: ProviderAdapter = {
      resolveModel: () => 'm',
      chunkDurationMs: () => 1_000,
      process: vi.fn(async () => ({
        text: 'local',
        segments: [],
        timeRanges: [],
        detectedLanguage: null,
      })),
      remoteMedia: () => (remote ? { uri: 'https://site/abcdefghijk', durationMs: 2_500 } : null),
      processRemote,
    };
    const sdk = new MediaSdk({ repository, sources, media, provider });
    return { sdk, repository, sources, media, provider, processRemote };
  }
  const youtube: MediaRequest = {
    kind: 'transcription',
    source: { kind: 'youtube', uri: 'https://youtube.com/watch?v=abcdefghijk' },
    provider: 'google-gemini',
  };

  it('processes remote media without download, inspection or local chunks, overlapping boundaries', async () => {
    const { sdk, repository, sources, media, processRemote } = remoteFixture(true);
    const job = await sdk.submit('alice', youtube);
    await sdk.runNext();
    const done = await sdk.get('alice', job.id);
    expect(done.status).toBe('completed');
    expect(sources.materialize).not.toHaveBeenCalled();
    expect(media.inspect).not.toHaveBeenCalled();
    expect(media.chunk).not.toHaveBeenCalled();
    const record = await repository.get('alice', job.id);
    expect(record?.sourceFingerprint).toBe('remote:youtube:youtube:abcdefghijk');
    expect(record?.plan?.[0]).toMatchObject({ startMs: 0, endMs: 1_000, keepEndMs: 875 });
    expect(processRemote.mock.calls.map((call) => call[1])).toEqual(record?.plan);
    expect(processRemote.mock.calls[0]![0]).toEqual({
      uri: 'https://site/abcdefghijk',
      durationMs: 2_500,
    });
    expect(done.result?.text).toBe('remote 0 remote 1 remote 2');
  });

  it('keeps the download path when the provider declines and rejects a changed identity', async () => {
    const declined = remoteFixture(false);
    await declined.sdk.submit('alice', youtube);
    await declined.sdk.runNext();
    expect(declined.sources.materialize).toHaveBeenCalledOnce();
    expect(declined.processRemote).not.toHaveBeenCalled();

    // A download-path attempt saved byte checkpoints; a remote retry must not mix identities.
    let remote = false;
    const changed = remoteFixture(true);
    changed.provider.remoteMedia = () =>
      remote ? { uri: 'https://site/abcdefghijk', durationMs: 2_500 } : null;
    vi.mocked(changed.provider.process).mockRejectedValueOnce(new Error('local failure'));
    const job = await changed.sdk.submit('alice', youtube);
    await changed.sdk.runNext();
    expect((await changed.repository.get('alice', job.id))?.sourceFingerprint).toBe('bytes');
    remote = true;
    await changed.sdk.retry('alice', job.id);
    await changed.sdk.runNext();
    expect((await changed.sdk.get('alice', job.id)).error?.code).toBe('source_changed');
  });

  it('rejects remote media without a usable duration', async () => {
    const { sdk, provider } = remoteFixture(true);
    provider.remoteMedia = () => ({ uri: 'u', durationMs: 0 });
    const job = await sdk.submit('alice', youtube);
    await sdk.runNext();
    expect((await sdk.get('alice', job.id)).error?.code).toBe('invalid_source');
  });
});
