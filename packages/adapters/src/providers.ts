import type { MediaRequest, ResolvedSource } from '@media-ingest/contracts';
import {
  MediaError,
  type AdapterContext,
  type Artifact,
  type Chunk,
  type MediaInspection,
  type ProviderAdapter,
  type RemoteMedia,
  type SynthesisInput,
} from '@media-ingest/sdk';
import { ClaudeCodeProvider } from './providers/claude-code.js';
import { CodexProvider } from './providers/codex.js';
import { GeminiProvider } from './providers/gemini.js';
import { GoogleSpeechProvider } from './providers/google-speech.js';
import { OpenAiProvider } from './providers/openai.js';
import type { SubscriptionUnderstandingOptions } from './reasoning/reasoner.js';

export { ClaudeCodeProvider, CodexProvider, GeminiProvider, GoogleSpeechProvider, OpenAiProvider };
export { ApiProvider, type ApiTranslation } from './providers/api-provider.js';
export { SubscriptionProvider } from './providers/subscription-provider.js';
export type {
  SubscriptionReasoner,
  ReasoningInput,
  SubscriptionUnderstandingOptions,
} from './reasoning/reasoner.js';
export { parseChunk, parseModelJson } from './providers/shared.js';
export { parseOpenAi } from './providers/openai.js';

/** Registry members implement format selection and translation as well as chunk processing. */
/** Optional capabilities; an override without them keeps the default download-and-concatenate path. */
type OptionalCapability = 'sourceMedia' | 'synthesize' | 'remoteMedia' | 'processRemote';
export type NodeProviderAdapter = Required<Omit<ProviderAdapter, OptionalCapability>> &
  Pick<ProviderAdapter, OptionalCapability>;

export interface NodeProviderOptions {
  overrides?: Partial<Record<MediaRequest['provider'], NodeProviderAdapter>>;
  openaiApiKey?: string;
  geminiApiKey?: string;
  /** Let Gemini read public YouTube videos itself instead of downloading them. Default true. */
  geminiYoutubeUrls?: boolean;
  googleCredentials?: Record<string, unknown>;
  googleProject?: string;
  googleRecognizer?: string;
  subscription?: SubscriptionUnderstandingOptions;
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
  openai: OpenAiProvider.capabilities,
  'google-gemini': GeminiProvider.capabilities,
  'google-speech': GoogleSpeechProvider.capabilities,
  codex: CodexProvider.capabilities,
  'claude-code': ClaudeCodeProvider.capabilities,
} as const;

export class NodeProviders implements NodeProviderAdapter {
  private readonly providers: Record<MediaRequest['provider'], NodeProviderAdapter>;

  constructor(options: NodeProviderOptions = {}) {
    const { models, timeoutMs, overrides } = options;
    const openai = {
      apiKey: options.openaiApiKey,
      model: models?.openai,
      translationModel: models?.translation,
      timeoutMs,
    };
    const gemini = {
      apiKey: options.geminiApiKey,
      transcriptionModel: models?.geminiTranscription,
      understandingModel: models?.geminiUnderstanding,
      translationModel: models?.translation,
      youtubeUrls: options.geminiYoutubeUrls,
      timeoutMs,
    };
    const translate = gemini.apiKey
      ? GeminiProvider.translator(gemini)
      : OpenAiProvider.translator(openai);
    this.providers = {
      openai: overrides?.openai ?? new OpenAiProvider(openai, translate),
      'google-gemini': overrides?.['google-gemini'] ?? new GeminiProvider(gemini, translate),
      'google-speech':
        overrides?.['google-speech'] ??
        new GoogleSpeechProvider(
          {
            googleRecognizer: options.googleRecognizer,
            googleCredentials: options.googleCredentials,
            googleProject: options.googleProject,
            model: models?.googleSpeech,
            timeoutMs,
          },
          translate,
        ),
      codex:
        overrides?.codex ?? new CodexProvider(options.subscription, models?.codexUnderstanding),
      'claude-code':
        overrides?.['claude-code'] ??
        new ClaudeCodeProvider(options.subscription, models?.claudeUnderstanding),
    };
  }

  resolveModel(request: MediaRequest) {
    return this.providers[request.provider].resolveModel(request);
  }

  chunkDurationMs(request: MediaRequest) {
    return this.providers[request.provider].chunkDurationMs(request);
  }

  inputFormat(request: MediaRequest, inspection: MediaInspection) {
    return this.providers[request.provider].inputFormat(request, inspection);
  }

  sourceMedia(request: MediaRequest): 'audio' | 'video' {
    return this.providers[request.provider].sourceMedia?.(request) ?? 'video';
  }

  process(artifact: Artifact, request: MediaRequest, context: AdapterContext) {
    return this.providers[request.provider].process(artifact, request, context);
  }

  remoteMedia(request: MediaRequest, source: ResolvedSource): RemoteMedia | null {
    return this.providers[request.provider].remoteMedia?.(request, source) ?? null;
  }

  async processRemote(
    media: RemoteMedia,
    chunk: Chunk,
    request: MediaRequest,
    context: AdapterContext,
  ) {
    const provider = this.providers[request.provider];
    if (!provider.processRemote)
      throw new MediaError('invalid_request', 'Provider cannot read remote media');
    return provider.processRemote(media, chunk, request, context);
  }

  async synthesize(input: SynthesisInput, request: MediaRequest, context: AdapterContext) {
    return (await this.providers[request.provider].synthesize?.(input, request, context)) ?? null;
  }

  translate(text: string, request: MediaRequest, context: AdapterContext) {
    return this.providers[request.provider].translate(text, request, context);
  }
}
