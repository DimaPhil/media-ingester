import type { MediaRequest, ProcessedMedia, ResolvedSource } from '@media-ingest/contracts';

/** Bounded candidate scan per media identity. A miss only costs a fresh run. */
export const RESULT_CACHE_CANDIDATES = 100;

/**
 * Request fields that define an equivalent output. Source identity is matched separately.
 * Transcription ignores its optional prompt hint; understanding requires the exact prompt.
 */
export function resultCacheKey(request: MediaRequest): string {
  return JSON.stringify([
    request.kind,
    request.provider,
    request.model ?? null,
    request.inputLanguage ?? null,
    request.targetLanguage ?? null,
    request.kind === 'understanding' ? request.prompt : null,
  ]);
}

/**
 * Returns the newest candidate produced by an equivalent request. Candidates are newest first.
 * Site media IDs are only unique per site, so `site` restricts them to the same source kind and
 * download provider. Content fingerprints need no namespace.
 */
export function findReusableResult(
  request: MediaRequest,
  candidates: ProcessedMedia[],
  site?: ResolvedSource,
): ProcessedMedia | undefined {
  const key = resultCacheKey(request);
  return candidates.find(
    (candidate) =>
      (!site ||
        (candidate.request.source.kind === request.source.kind &&
          candidate.media?.source.metadata.downloadProvider === site.metadata.downloadProvider)) &&
      resultCacheKey(candidate.request) === key,
  );
}
