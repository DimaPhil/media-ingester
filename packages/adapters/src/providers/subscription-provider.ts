import type { MediaRequest } from '@media-ingest/contracts';
import {
  MediaError,
  type AdapterContext,
  type Artifact,
  type MediaInputFormat,
  type MediaInspection,
  type ProviderAdapter,
} from '@media-ingest/sdk';
import {
  translateSubscription,
  understandSubscription,
  type SubscriptionUnderstandingOptions,
} from '../subscription-understanding.js';
import type { SubscriptionReasoner } from '../reasoning/reasoner.js';
import { assertSelectedProvider } from './shared.js';

export abstract class SubscriptionProvider implements ProviderAdapter {
  constructor(
    private readonly configuration: SubscriptionUnderstandingOptions | undefined,
    protected readonly understandingModel: string,
    protected readonly reasoner: SubscriptionReasoner,
  ) {}

  protected get subscription(): SubscriptionUnderstandingOptions {
    if (!this.configuration?.codexHome)
      throw new MediaError(
        'subscription_configuration',
        'MEDIA_CODEX_HOME must point to a dedicated authenticated credential directory',
      );
    return this.configuration;
  }

  resolveModel(request: MediaRequest): string {
    assertSelectedProvider(request, this.reasoner.provider);
    return request.model ?? this.understandingModel;
  }

  chunkDurationMs(): number {
    return 60_000;
  }

  sourceMedia(request: MediaRequest): 'audio' | 'video' {
    return request.kind === 'understanding' ? 'video' : 'audio';
  }

  inputFormat(request: MediaRequest, inspection: MediaInspection): MediaInputFormat {
    return request.kind === 'understanding' && inspection.hasVideo ? 'video' : 'audio_pcm';
  }

  async process(artifact: Artifact, request: MediaRequest, context: AdapterContext) {
    assertSelectedProvider(request, this.reasoner.provider);
    if (request.kind !== 'understanding')
      throw new MediaError('invalid_request', 'This provider requires an understanding request');
    return understandSubscription(artifact, request, context, this.subscription, this.reasoner);
  }

  async translate(text: string, request: MediaRequest, context: AdapterContext): Promise<string> {
    assertSelectedProvider(request, this.reasoner.provider);
    if (!request.targetLanguage) return text;
    const model =
      request.kind === 'transcription' ? this.understandingModel : this.resolveModel(request);
    return translateSubscription(
      text,
      { ...request, model },
      context,
      this.subscription,
      this.reasoner,
    );
  }
}
