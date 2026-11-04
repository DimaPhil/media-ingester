import type { CodexAudioOptions } from '../codex-audio.js';
import type { SubscriptionProcessOptions, SubscriptionProvider } from '../subscription-runtime.js';

export interface SubscriptionUnderstandingOptions extends CodexAudioOptions {
  claudeHome?: string;
  claudePath?: string;
}

export interface Frame {
  path: string;
  timestampMs: number;
}
export interface ReasoningInput {
  prompt: string;
  frames: readonly Frame[];
  model: string;
  jsonSchema: string;
}

export interface SubscriptionReasoner {
  readonly provider: SubscriptionProvider;
  credentialHome(options: SubscriptionUnderstandingOptions): string | undefined;
  run(
    input: ReasoningInput,
    options: SubscriptionUnderstandingOptions,
    processOptions: SubscriptionProcessOptions,
  ): Promise<unknown>;
}
