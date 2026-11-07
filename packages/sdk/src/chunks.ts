import { isDeepStrictEqual } from 'node:util';
import { resultSchema, type MediaRequest, type MediaResult } from '@media-ingest/contracts';
import { MediaError } from './errors.js';
import type { Chunk, ChunkOutput, LoudnessProfile } from './ports.js';

/** A boundary is searched for in the last quarter of each chunk. */
const pauseSearchFraction = 0.25;
/** Quiet span that must surround a cut; shorter than a sentence pause, longer than most stops. */
const pauseWindowMs = 300;
/** A span is a pause when it is this quiet in absolute terms... */
const pauseCeilingDbfs = -45;
/** ...or this far below the chunk's median level (speech over a noise floor). */
const pauseDropDb = 12;
/** Each side of an unpaused boundary is extracted twice, so a word on the cut is complete once. */
const maxOverlapPadMs = 2000;
/** Transcript tokens compared on each side of an overlapped boundary. */
const stitchWindowTokens = 24;
/** Shortest common run trusted as the same speech in both chunks. */
const stitchMinTokens = 3;

/**
 * Splits media into chunks of at most `chunkDurationMs`. With a loudness profile, each boundary
 * is placed in the quietest pause near the chunk limit. Where no pause exists, neighboring
 * chunks overlap and keep ranges decide which chunk owns each part of the result.
 */
export function planChunks(
  durationMs: number,
  chunkDurationMs: number,
  maxChunks = 10000,
  loudness?: LoudnessProfile,
): Chunk[] {
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    !Number.isFinite(chunkDurationMs) ||
    chunkDurationMs <= 0
  )
    throw new MediaError('invalid_media', 'Media and chunk durations must be finite and positive');
  if (!loudness || durationMs <= chunkDurationMs) {
    const count = Math.ceil(durationMs / chunkDurationMs);
    if (count > maxChunks)
      throw new MediaError('media_too_large', `Media exceeds the ${maxChunks} chunk limit`);
    return Array.from({ length: count }, (_, index) => ({
      index,
      startMs: index * chunkDurationMs,
      endMs: Math.min(durationMs, (index + 1) * chunkDurationMs),
    }));
  }
  if (!Number.isFinite(loudness.frameMs) || loudness.frameMs <= 0)
    throw new MediaError('invalid_media', 'Loudness frames must have a positive duration');
  const pad = Math.min(maxOverlapPadMs, Math.floor(chunkDurationMs / 8));
  const chunks: Chunk[] = [];
  let startMs = 0;
  let keepStartMs = 0;
  for (;;) {
    if (chunks.length >= maxChunks)
      throw new MediaError('media_too_large', `Media exceeds the ${maxChunks} chunk limit`);
    const chunk: Chunk = { index: chunks.length, startMs, endMs: durationMs };
    if (keepStartMs !== startMs) chunk.keepStartMs = keepStartMs;
    chunks.push(chunk);
    if (durationMs - startMs <= chunkDurationMs) return chunks;
    const limitMs = startMs + chunkDurationMs;
    const cut = findPause(loudness, limitMs - chunkDurationMs * pauseSearchFraction, limitMs);
    if (cut !== null) {
      chunk.endMs = cut;
      startMs = keepStartMs = cut;
    } else {
      chunk.endMs = limitMs;
      if (pad > 0) chunk.keepEndMs = limitMs - pad;
      keepStartMs = limitMs - pad;
      startMs = limitMs - 2 * pad;
    }
  }
}

function power(level: number): number {
  return Number.isNaN(level) ? 0 : 10 ** (level / 10);
}

function decibels(meanPower: number): number {
  return meanPower > 0 ? 10 * Math.log10(meanPower) : -Infinity;
}

/** Returns the center of the quietest pause fully inside [fromMs, toMs], or null. */
function findPause({ frameMs, levels }: LoudnessProfile, fromMs: number, toMs: number) {
  const width = Math.max(1, Math.round(pauseWindowMs / frameMs));
  const first = Math.ceil(fromMs / frameMs);
  const last = Math.min(Math.floor(toMs / frameMs), levels.length) - width;
  if (first < 0 || last < first) return null;
  // sums[k] is the total power of the window starting at frame first + k.
  const sums: number[] = [];
  let sum = 0;
  for (let index = first; index < first + width; index++) sum += power(levels[index]!);
  for (let at = first; ; at++) {
    sums.push(sum);
    if (at >= last) break;
    sum = Math.max(0, sum + power(levels[at + width]!) - power(levels[at]!));
  }
  let bestK = 0;
  // Equal quietness prefers the later window, which yields fewer chunks.
  for (let k = 1; k < sums.length; k++) if (sums[k]! <= sums[bestK]!) bestK = k;
  const best = sums[bestK]!;
  const span = Array.from(
    { length: last + width - first },
    (_, offset) => levels[first + offset]!,
  ).sort((a, b) => a - b);
  const median = span[Math.floor(span.length / 2)]!;
  const quiet = decibels(best / width);
  if (quiet > pauseCeilingDbfs && quiet > median - pauseDropDb) return null;
  // Center the cut in the surrounding run of windows within 1 dB of the quietest.
  const tolerance = best * 10 ** 0.1;
  let low = bestK;
  let high = bestK;
  while (low > 0 && sums[low - 1]! <= tolerance) low--;
  while (high < sums.length - 1 && sums[high + 1]! <= tolerance) high++;
  const center = (first + (low + high) / 2 + width / 2) * frameMs;
  return Math.min(toMs, Math.max(fromMs, Math.round(center)));
}

/**
 * Joins transcripts of overlapping chunks. The longest run of words shared by the end of `before`
 * and the start of `after` marks the same speech; each side is cut there, dropping the partial
 * words at the extraction edges. Without a trusted run, both texts are kept whole: a few repeated
 * words are preferable to losing any.
 */
export function stitchOverlap(before: string, after: string): [string, string] {
  const tokens = (text: string) =>
    [...text.matchAll(/\S+/g)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      key: match[0].toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''),
    }));
  const left = tokens(before);
  const right = tokens(after).slice(0, stitchWindowTokens);
  const from = Math.max(0, left.length - stitchWindowTokens);
  let best = { length: 0, leftEnd: 0, rightEnd: 0 };
  let previous = Array.from({ length: right.length + 1 }, () => 0);
  for (let i = from; i < left.length; i++) {
    const current = Array.from({ length: right.length + 1 }, () => 0);
    for (let j = 0; j < right.length; j++) {
      if (!left[i]!.key || left[i]!.key !== right[j]!.key) continue;
      current[j + 1] = previous[j]! + 1;
      if (current[j + 1]! >= best.length)
        best = { length: current[j + 1]!, leftEnd: i, rightEnd: j };
    }
    previous = current;
  }
  if (best.length < stitchMinTokens) return [before, after];
  return [
    before.slice(0, left[best.leftEnd]!.end),
    after.slice(right[best.rightEnd]!.end).trimStart(),
  ];
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
  let overlapsPrevious = false;
  for (const chunk of ordered) {
    const output = outputs[String(chunk.index)];
    if (!output) throw new MediaError('missing_chunk', 'A completed chunk is missing');
    if (overlapsPrevious && request.kind === 'transcription' && texts.length) {
      const [before, after] = stitchOverlap(texts.at(-1)!, output.text);
      texts[texts.length - 1] = before;
      texts.push(after);
    } else texts.push(output.text);
    overlapsPrevious = chunk.keepEndMs !== undefined;
    if (output.provenance) {
      const merged = (result.provenance ??= {});
      mergeProvenanceField(merged, output.provenance, 'transcription');
      mergeProvenanceField(merged, output.provenance, 'frameIntervalMs');
    }
    result.detectedLanguage ??= output.detectedLanguage;
    // In an overlap, the chunk whose keep range holds an item's midpoint owns it.
    const owned = <T extends { startMs: number; endMs: number }>(item: T): T | null => {
      const absolute = {
        ...item,
        startMs: item.startMs + chunk.startMs,
        endMs: item.endMs + chunk.startMs,
      };
      const middle = (absolute.startMs + absolute.endMs) / 2;
      if (chunk.keepStartMs !== undefined && middle < chunk.keepStartMs) return null;
      if (chunk.keepEndMs !== undefined && middle >= chunk.keepEndMs) return null;
      return absolute;
    };
    for (const segment of output.segments) {
      const kept = owned(segment);
      if (kept) result.segments.push(kept);
    }
    for (const range of output.timeRanges) {
      const kept = owned(range);
      if (kept) result.timeRanges.push(kept);
    }
  }
  result.text = texts
    .filter((text) => text.trim())
    .join(request.kind === 'understanding' ? '\n\n' : ' ')
    .trim();
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
