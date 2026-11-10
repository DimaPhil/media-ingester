import type { MediaRequest } from '@media-ingest/contracts';
import { MediaError } from './errors.js';
import type {
  AdapterContext,
  Chunk,
  ChunkOutput,
  ProviderAdapter,
  SynthesisOutput,
  SynthesisPart,
} from './ports.js';

/** Characters of analyses sent in one synthesis call; larger inputs are reduced in levels. */
export const SYNTHESIS_BUDGET_CHARS = 200_000;

/** Places each chunk's understanding on the absolute media timeline. */
export function synthesisParts(plan: Chunk[], outputs: Record<string, ChunkOutput>) {
  return [...plan]
    .sort((a, b) => a.index - b.index)
    .map((chunk): SynthesisPart => {
      const output = outputs[String(chunk.index)];
      if (!output) throw new MediaError('missing_chunk', 'A completed chunk is missing');
      return {
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        text: output.text,
        timeRanges: output.timeRanges.map((range) => ({
          ...range,
          startMs: range.startMs + chunk.startMs,
          endMs: range.endMs + chunk.startMs,
        })),
      };
    });
}

function size(part: SynthesisPart): number {
  return part.text.length + JSON.stringify(part.timeRanges).length;
}

/** Consecutive groups within the budget; every group makes progress by holding at least two parts. */
function group(parts: SynthesisPart[], budget: number): SynthesisPart[][] {
  const groups: SynthesisPart[][] = [];
  let current: SynthesisPart[] = [];
  let used = 0;
  for (const part of parts) {
    if (current.length >= 2 && used + size(part) > budget) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(part);
    used += size(part);
  }
  if (current.length) groups.push(current);
  // A trailing single part joins the previous group so each level shrinks.
  if (groups.length > 1 && groups.at(-1)!.length === 1) groups.at(-2)!.push(...groups.pop()!);
  return groups;
}

function validated(output: SynthesisOutput, startMs: number, endMs: number): SynthesisOutput {
  if (
    !output.text.trim() ||
    output.timeRanges.some(
      (range) => range.endMs < range.startMs || range.startMs < startMs || range.endMs > endMs,
    )
  )
    throw new MediaError(
      'invalid_provider_output',
      'Synthesis returned empty text or timestamps outside its span',
    );
  return {
    text: output.text.trim(),
    timeRanges: [...output.timeRanges].sort((a, b) => a.startMs - b.startMs),
  };
}

/**
 * Answers the request for the whole media from per-chunk analyses. Returns null when the
 * provider cannot synthesize. Inputs over the budget are combined span by span first.
 */
export async function synthesizeWhole(
  provider: ProviderAdapter,
  parts: SynthesisPart[],
  durationMs: number,
  request: MediaRequest,
  context: AdapterContext,
  budget = SYNTHESIS_BUDGET_CHARS,
): Promise<SynthesisOutput | null> {
  if (!provider.synthesize) return null;
  let level = parts;
  for (;;) {
    const groups = level.length > 1 ? group(level, budget) : [level];
    if (groups.length === 1) {
      const output = await provider.synthesize(
        { durationMs, startMs: 0, endMs: durationMs, parts: level, final: true },
        request,
        context,
      );
      return output && validated(output, 0, durationMs);
    }
    const next: SynthesisPart[] = [];
    for (const span of groups) {
      context.signal.throwIfAborted();
      const startMs = span[0]!.startMs;
      const endMs = span.at(-1)!.endMs;
      const output = await provider.synthesize(
        { durationMs, startMs, endMs, parts: span, final: false },
        request,
        context,
      );
      if (!output) return null;
      next.push({ startMs, endMs, ...validated(output, startMs, endMs) });
    }
    level = next;
  }
}
