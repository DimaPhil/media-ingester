import type { MediaRequest } from '@media-ingest/contracts';
import type {
  AdapterContext,
  Artifact,
  ChunkOutput,
  MediaInputFormat,
  MediaInspection,
  ProviderAdapter,
} from '@media-ingest/sdk';
import { MediaError } from '@media-ingest/sdk';
import { transcribeCodexAudio } from './codex-audio.js';
import { understandSubscription, translateSubscription } from './subscription-understanding.js';

import { processGemini, translateGemini } from './providers/gemini.js';
import { transcribeOpenAi, translateOpenAi } from './providers/openai.js';
import { transcribeGoogleSpeech } from './providers/google-speech.js';

export { parseChunk, parseModelJson } from './providers/shared.js';
export { parseOpenAi } from './providers/openai.js';

export interface NodeProviderOptions {
  openaiApiKey?: string;
  geminiApiKey?: string;
  googleCredentials?: Record<string, unknown>;
  googleProject?: string;
  googleRecognizer?: string;
  subscription?: {
    codexHome: string;
    claudeHome?: string;
    codexPath?: string;
    claudePath?: string;
    ffmpegPath?: string;
    ffprobePath?: string;
    timeoutMs?: number;
  };
  models?: {
    openai?: string;
    geminiTranscription?: string;
    geminiUnderstanding?: string;
    googleSpeech?: string;
    translation?: string;
    codexUnderstanding?: string;
    claudeUnderstanding?: string;
  };
  timeoutMs?: number;
}
/** Transport capabilities of the built-in adapters, independent of an individual model default. */
export const BUILTIN_PROVIDER_CAPABILITIES = {
  openai: { transcription: true, understanding: false, nativeVideo: false },
  'google-gemini': { transcription: true, understanding: true, nativeVideo: true },
  'google-speech': { transcription: true, understanding: false, nativeVideo: false },
  codex: { transcription: true, understanding: true, nativeVideo: false },
  'claude-code': { transcription: false, understanding: true, nativeVideo: false },
} as const;
export class NodeProviders implements ProviderAdapter {
  constructor(private readonly options: NodeProviderOptions = {}) {}
  resolveModel(request: MediaRequest): string {
    if (request.provider === 'codex' && request.kind === 'transcription') {
      if (request.model && request.model !== 'codex-realtime-v3')
        throw new MediaError(
          'invalid_request',
          'Codex transcription uses the codex-realtime-v3 protocol; its ASR model is service-selected',
        );
      return 'codex-realtime-v3';
    }
    if (request.model) return request.model;
    if (request.provider === 'codex')
      return this.options.models?.codexUnderstanding ?? 'gpt-6.1-sol';
    if (request.provider === 'claude-code')
      return this.options.models?.claudeUnderstanding ?? 'sonnet';
    if (request.provider === 'openai') return this.options.models?.openai ?? 'gpt-4o-transcribe';
    if (request.provider === 'google-speech') return this.options.models?.googleSpeech ?? 'chirp_3';
    return request.kind === 'understanding'
      ? (this.options.models?.geminiUnderstanding ?? 'gemini-2.5-pro')
      : (this.options.models?.geminiTranscription ?? 'gemini-2.5-flash');
  }
  chunkDurationMs(request: MediaRequest): number {
    if (request.provider === 'codex' || request.provider === 'claude-code') return 60_000;
    return request.provider === 'google-speech' ? 55_000 : 10 * 60_000;
  }
  inputFormat(request: MediaRequest, inspection: MediaInspection): MediaInputFormat {
    if (request.provider === 'codex' && request.kind === 'transcription') return 'audio_pcm';
    if (
      (request.provider === 'codex' || request.provider === 'claude-code') &&
      request.kind === 'understanding'
    )
      return inspection.hasVideo ? 'video' : 'audio_pcm';
    return BUILTIN_PROVIDER_CAPABILITIES[request.provider].nativeVideo && inspection.hasVideo
      ? 'video'
      : 'audio';
  }
  private signal(context: AdapterContext): AbortSignal {
    return AbortSignal.any([
      context.signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 10 * 60_000),
    ]);
  }
  async process(
    artifact: Artifact,
    request: MediaRequest,
    context: AdapterContext,
  ): Promise<ChunkOutput> {
    if (request.provider === 'codex' || request.provider === 'claude-code') {
      const options = this.subscriptionOptions();
      if (request.kind === 'transcription') {
        this.resolveModel(request);
        return transcribeCodexAudio(artifact, context, options);
      }
      return understandSubscription(artifact, request, context, options);
    }
    const signal = this.signal(context);
    if (request.kind === 'understanding' && request.provider !== 'google-gemini')
      throw new Error('Understanding requires Gemini');
    const model = this.resolveModel(request);
    switch (request.provider) {
      case 'google-gemini':
        return processGemini(artifact, request, model, this.options.geminiApiKey, signal);
      case 'google-speech':
        return transcribeGoogleSpeech(artifact, request, model, this.options, signal);
      case 'openai':
        return transcribeOpenAi(artifact, request, model, this.options.openaiApiKey, signal);
    }
  }
  private subscriptionOptions() {
    if (!this.options.subscription?.codexHome)
      throw new MediaError(
        'subscription_configuration',
        'MEDIA_CODEX_HOME must point to a dedicated authenticated credential directory',
      );
    return this.options.subscription;
  }
  async translate(text: string, request: MediaRequest, context: AdapterContext): Promise<string> {
    if (!request.targetLanguage) return text;
    if (request.provider === 'codex' || request.provider === 'claude-code')
      return translateSubscription(
        text,
        {
          ...request,
          model:
            request.kind === 'transcription'
              ? (this.options.models?.codexUnderstanding ?? 'gpt-6.1-sol')
              : this.resolveModel(request),
        },
        context,
        this.subscriptionOptions(),
      );
    const prompt = `Translate accurately to ${request.targetLanguage}, preserving speaker markers. Return JSON {"translatedText":string}.\n\n${text}`;
    if (this.options.geminiApiKey) {
      return translateGemini(
        prompt,
        this.options.models?.translation ??
          this.options.models?.geminiTranscription ??
          'gemini-2.5-flash',
        this.options.geminiApiKey,
        this.signal(context),
      );
    }
    return translateOpenAi(
      prompt,
      this.options.models?.translation ?? 'gpt-4.1-mini',
      this.options.openaiApiKey,
      this.signal(context),
    );
  }
}
