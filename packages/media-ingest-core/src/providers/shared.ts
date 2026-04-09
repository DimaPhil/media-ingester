import type { ProviderCapability } from '../media';
import type { ProviderId } from '../types';

import type { TranscriptionChunkResult } from './types';

interface OpenAiTranscriptionPayload {
  text?: string;
  language?: string;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
    speaker?: string;
  }>;
}

export interface OpenAiTranscriptionRequestOptions {
  response_format: 'json' | 'verbose_json' | 'diarized_json';
  timestamp_granularities?: ['segment'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOpenAiTranscriptionPayload(value: unknown): value is OpenAiTranscriptionPayload {
  return isRecord(value);
}

export function stripCodeFence(value: string): string {
  return value.replace(/^```(?:json)?/u, '').replace(/```$/u, '').trim();
}

export function parseJsonObject<T>(value: string): T {
  return JSON.parse(stripCodeFence(value)) as T;
}

export function providerCapabilityFor(kind: ProviderId): ProviderCapability {
  switch (kind) {
    case 'openai':
      return {
        maxWholeFileDurationMs: 12 * 60 * 1000,
        chunkDurationMs: 12 * 60 * 1000,
        overlapMs: 2_000,
      };
    case 'google-speech':
      return {
        maxWholeFileDurationMs: 25 * 60 * 1000,
        chunkDurationMs: 20 * 60 * 1000,
        overlapMs: 2_000,
      };
    case 'google-gemini':
      return {
        maxWholeFileDurationMs: 20 * 60 * 1000,
        chunkDurationMs: 10 * 60 * 1000,
        overlapMs: 2_000,
      };
  }
}

export function buildOpenAiTranscriptionRequestOptions(
  model: string,
): OpenAiTranscriptionRequestOptions {
  if (model.includes('transcribe-diarize')) {
    return {
      response_format: 'diarized_json',
    };
  }

  if (model.startsWith('whisper-')) {
    return {
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    };
  }

  return {
    response_format: 'json',
  };
}

export function normalizeOpenAiTranscriptionPayload(payload: unknown): TranscriptionChunkResult {
  const normalized = isOpenAiTranscriptionPayload(payload) ? payload : {};
  return {
    text: normalized.text ?? '',
    detectedLanguage: normalized.language ?? null,
    segments:
      normalized.segments?.map((segment) => ({
        startMs: Math.round((segment.start ?? 0) * 1000),
        endMs: Math.round((segment.end ?? 0) * 1000),
        text: segment.text ?? '',
        ...(segment.speaker ? { speaker: segment.speaker } : {}),
      })) ?? [],
    raw: payload,
  };
}
