import type { MediaRequest } from '@media-ingest/contracts';
import { MediaError, type AdapterContext, type Artifact } from '@media-ingest/sdk';
import { transcribeCodexAudio } from '../codex-audio.js';
import { CodexReasoner } from '../reasoning/codex.js';
import type { SubscriptionUnderstandingOptions } from '../subscription-understanding.js';
import { SubscriptionProvider } from './subscription-provider.js';
import { assertSelectedProvider } from './shared.js';

export class CodexProvider extends SubscriptionProvider {
  static readonly capabilities = {
    transcription: true,
    understanding: true,
    nativeVideo: false,
  } as const;

  constructor(options?: SubscriptionUnderstandingOptions, understandingModel = 'gpt-6.1-sol') {
    super(options, understandingModel, new CodexReasoner());
  }

  override resolveModel(request: MediaRequest): string {
    if (request.kind !== 'transcription') return super.resolveModel(request);
    assertSelectedProvider(request, this.reasoner.provider);
    if (request.model && request.model !== 'codex-realtime-v3')
      throw new MediaError(
        'invalid_request',
        'Codex transcription uses the codex-realtime-v3 protocol; its ASR model is service-selected',
      );
    return 'codex-realtime-v3';
  }

  override async process(artifact: Artifact, request: MediaRequest, context: AdapterContext) {
    if (request.kind !== 'transcription') return super.process(artifact, request, context);
    this.resolveModel(request);
    return transcribeCodexAudio(artifact, context, this.subscription);
  }
}
