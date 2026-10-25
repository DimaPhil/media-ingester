import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeProviders } from '../src/providers.js';
import { transcribeCodexAudio } from '../src/codex-audio.js';
import {
  understandSubscription,
  translateSubscription,
} from '../src/subscription-understanding.js';
import type { MediaRequest } from '@media-ingest/contracts';

vi.mock('../src/codex-audio.js', () => ({ transcribeCodexAudio: vi.fn() }));
vi.mock('../src/subscription-understanding.js', () => ({
  understandSubscription: vi.fn(),
  translateSubscription: vi.fn(),
}));
const context = {
  ownerId: 'owner',
  jobId: 'job',
  attempt: 1,
  signal: new AbortController().signal,
};
const artifact = { uri: '/tmp/clip', fileName: 'clip.mp4', fingerprint: 'hash' };
const source = { kind: 'upload' as const, uri: 'clip' };
const output = { text: 'spoken words', segments: [], timeRanges: [], detectedLanguage: null };
const subscription = { codexHome: '/auth/codex', claudeHome: '/auth/claude' };
beforeEach(() => vi.resetAllMocks());

describe('subscription provider dispatch', () => {
  it('pins transcription protocol and preserves explicit understanding models', () => {
    const provider = new NodeProviders({
      models: { codexUnderstanding: 'chosen-codex', claudeUnderstanding: 'chosen-claude' },
    });
    const request: MediaRequest = { kind: 'transcription', provider: 'codex', source };
    expect(provider.resolveModel(request)).toBe('codex-realtime-v3');
    expect(() => provider.resolveModel({ ...request, model: 'gpt-anything' })).toThrow(
      'service-selected',
    );
    expect(
      provider.resolveModel({
        kind: 'understanding',
        provider: 'codex',
        prompt: 'Describe',
        source,
      }),
    ).toBe('chosen-codex');
    expect(
      provider.resolveModel({
        kind: 'understanding',
        provider: 'claude-code',
        prompt: 'Describe',
        source,
      }),
    ).toBe('chosen-claude');
    expect(
      provider.resolveModel({
        kind: 'understanding',
        provider: 'codex',
        prompt: 'Describe',
        source,
        model: 'explicit',
      }),
    ).toBe('explicit');
    expect(provider.chunkDurationMs(request)).toBe(60000);
  });
  it('uses only native ASR and records unknown underlying model honestly', async () => {
    vi.mocked(transcribeCodexAudio).mockResolvedValue(output);
    const provider = new NodeProviders({
      subscription,
      openaiApiKey: 'unused',
      geminiApiKey: 'unused',
    });
    const request: MediaRequest = { kind: 'transcription', provider: 'codex', source };
    expect(await provider.process(artifact, request, context)).toEqual({
      ...output,
      provenance: { transcription: { provider: 'codex', protocol: 'realtime-v3', model: null } },
    });
    expect(transcribeCodexAudio).toHaveBeenCalledWith(artifact, context, subscription);
    vi.mocked(transcribeCodexAudio).mockRejectedValue(new Error('Native auth required'));
    await expect(provider.process(artifact, request, context)).rejects.toThrow(
      'Native auth required',
    );
    expect(understandSubscription).not.toHaveBeenCalled();
    await expect(new NodeProviders().process(artifact, request, context)).rejects.toThrow(
      'MEDIA_CODEX_HOME',
    );
  });
  it.each(['codex', 'claude-code'] as const)(
    'passes %s clips and translations to its native adapter',
    async (providerId) => {
      const request: MediaRequest = {
        kind: 'understanding',
        provider: providerId,
        prompt: 'Describe',
        source,
        targetLanguage: 'fr',
      };
      const provider = new NodeProviders({ subscription });
      const video = { durationMs: 1000, hasAudio: true, hasVideo: true };
      expect(provider.inputFormat(request, video)).toBe('video');
      expect(provider.inputFormat(request, { ...video, hasVideo: false })).toBe('audio_pcm');
      vi.mocked(understandSubscription).mockResolvedValue(output);
      expect(await provider.process(artifact, request, context)).toEqual(output);
      expect(understandSubscription).toHaveBeenCalledWith(artifact, request, context, subscription);
      vi.mocked(translateSubscription).mockResolvedValue('bonjour');
      expect(await provider.translate('hello', request, context)).toBe('bonjour');
    },
  );
  it('uses the configured reasoning model for Codex ASR translation', async () => {
    vi.mocked(translateSubscription).mockResolvedValue('bonjour');
    const request: MediaRequest = {
      kind: 'transcription',
      provider: 'codex',
      source,
      model: 'codex-realtime-v3',
      targetLanguage: 'fr',
    };
    await new NodeProviders({
      subscription,
      models: { codexUnderstanding: 'chosen-model' },
    }).translate('hello', request, context);
    expect(translateSubscription).toHaveBeenCalledWith(
      'hello',
      { ...request, model: 'chosen-model' },
      context,
      subscription,
    );
  });
});
