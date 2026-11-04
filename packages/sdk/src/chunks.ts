import { isDeepStrictEqual } from 'node:util';
import { resultSchema, type MediaRequest, type MediaResult } from '@media-ingest/contracts';
import { MediaError } from './errors.js';
import type { Chunk, ChunkOutput } from './ports.js';

export function planChunks(
  durationMs: number,
  chunkDurationMs: number,
  maxChunks = 10000,
): Chunk[] {
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    !Number.isFinite(chunkDurationMs) ||
    chunkDurationMs <= 0
  )
    throw new MediaError('invalid_media', 'Media and chunk durations must be finite and positive');
  const count = Math.ceil(durationMs / chunkDurationMs);
  if (count > maxChunks)
    throw new MediaError('media_too_large', `Media exceeds the ${maxChunks} chunk limit`);
  return Array.from({ length: count }, (_, index) => ({
    index,
    startMs: index * chunkDurationMs,
    endMs: Math.min(durationMs, (index + 1) * chunkDurationMs),
  }));
}

type Provenance = NonNullable<MediaResult['provenance']>;

function mergeProvenanceField<K extends keyof Provenance>(
  target: Provenance,
  source: Provenance,
  field: K,
): void {
  const next = source[field];
  if (next === undefined) return;
  if (target[field] !== undefined && !isDeepStrictEqual(target[field], next)) {
    throw new MediaError('inconsistent_provenance', `Chunk provenance disagrees on ${field}`);
  }
  target[field] = next;
}

export function aggregate(
  plan: Chunk[],
  outputs: Record<string, ChunkOutput>,
  request: MediaRequest,
): MediaResult {
  const ordered = [...plan].sort((a, b) => a.index - b.index);
  const result: MediaResult = {
    kind: request.kind,
    provider: request.provider,
    model: request.model!,
    text: '',
    segments: [],
    timeRanges: [],
    detectedLanguage: null,
  };
  const texts: string[] = [];
  for (const chunk of ordered) {
    const output = outputs[String(chunk.index)];
    if (!output) throw new MediaError('missing_chunk', 'A completed chunk is missing');
    texts.push(output.text);
    if (output.provenance) {
      const merged = (result.provenance ??= {});
      mergeProvenanceField(merged, output.provenance, 'transcription');
      mergeProvenanceField(merged, output.provenance, 'frameIntervalMs');
    }
    result.detectedLanguage ??= output.detectedLanguage;
    for (const segment of output.segments)
      result.segments.push({
        ...segment,
        startMs: segment.startMs + chunk.startMs,
        endMs: segment.endMs + chunk.startMs,
      });
    for (const range of output.timeRanges)
      result.timeRanges.push({
        ...range,
        startMs: range.startMs + chunk.startMs,
        endMs: range.endMs + chunk.startMs,
      });
  }
  result.text = texts.join(request.kind === 'understanding' ? '\n\n' : ' ').trim();
  result.segments.sort((a, b) => a.startMs - b.startMs);
  result.timeRanges.sort((a, b) => a.startMs - b.startMs);
  return resultSchema.parse(result);
}

export function validateChunk(output: ChunkOutput, request: MediaRequest, chunk: Chunk) {
  // Validate provider output through the public result schema before checkpointing.
  const validated = resultSchema.parse({
    ...output,
    kind: request.kind,
    provider: request.provider,
    model: request.model,
  });
  for (const range of [...validated.segments, ...validated.timeRanges]) {
    if (range.endMs < range.startMs || range.endMs > chunk.endMs - chunk.startMs)
      throw new MediaError(
        'invalid_provider_output',
        'Provider timestamps must fall within the chunk',
      );
  }
  return validated;
}
