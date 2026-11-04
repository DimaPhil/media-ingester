import type { SubscriptionUnderstandingOptions } from '../subscription-understanding.js';
import { ClaudeReasoner } from '../reasoning/claude.js';
import { SubscriptionProvider } from './subscription-provider.js';

export class ClaudeCodeProvider extends SubscriptionProvider {
  static readonly capabilities = {
    transcription: false,
    understanding: true,
    nativeVideo: false,
  } as const;

  constructor(options?: SubscriptionUnderstandingOptions, understandingModel = 'sonnet') {
    super(options, understandingModel, new ClaudeReasoner());
  }
}
