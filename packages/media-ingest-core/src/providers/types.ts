import type { ProviderCapability } from '../media';
import type { ProviderId, MediaSegment, TimeRange } from '../types';

export interface TranscriptionChunkResult {
  text: string;
  detectedLanguage: string | null;
  segments: MediaSegment[];
  raw?: unknown;
}

export interface UnderstandingChunkResult {
  responseText: string;
  timeRanges?: TimeRange[];
  raw?: unknown;
}

export interface TranscriptionProvider {
  readonly id: ProviderId;
  resolveModel(model?: string): string;
  capability(model?: string): ProviderCapability;
  transcribeChunk(input: {
    filePath: string;
    model?: string;
    inputLanguage?: string;
  }): Promise<TranscriptionChunkResult>;
  translateText?(input: {
    model?: string;
    text: string;
    targetLanguage: string;
  }): Promise<string>;
}

export interface UnderstandingProvider {
  readonly id: ProviderId;
  resolveModel(model?: string): string;
  capability(model?: string): ProviderCapability;
  understandChunk(input: {
    filePath: string;
    model?: string;
    prompt: string;
  }): Promise<UnderstandingChunkResult>;
}
