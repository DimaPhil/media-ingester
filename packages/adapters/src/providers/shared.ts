import { z } from 'zod';
import { rangeSchema, segmentSchema } from '@media-ingest/contracts';
import { MediaError, type ChunkOutput } from '@media-ingest/sdk';
import type { MediaRequest } from '@media-ingest/contracts';

export function assertSelectedProvider(request: MediaRequest, provider: MediaRequest['provider']) {
  if (request.provider !== provider)
    throw new MediaError(
      'invalid_request',
      `The ${provider} adapter cannot handle a ${request.provider} request`,
    );
}
const chunkSchema = z.object({
  text: z.string(),
  segments: z.array(segmentSchema).default([]),
  timeRanges: z.array(rangeSchema).default([]),
  detectedLanguage: z.string().nullable().default(null),
});
export function parseChunk(value: unknown): ChunkOutput {
  return chunkSchema.parse(value);
}
export function parseModelJson(text: string): unknown {
  return JSON.parse(
    text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, ''),
  );
}
export async function checked(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'error' });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  return response;
}
export function key(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
export function parseTranslation(text: string): string {
  return z.object({ translatedText: z.string() }).parse(parseModelJson(text)).translatedText;
}
