import {
  processedMediaSchema,
  type MediaResult,
  type ProcessedMedia,
  type ProcessedMediaDetails,
  type ProcessedMediaSummary,
} from '@media-ingest/contracts';
import type { JobRecord } from './ports.js';

export function makeProcessedMedia(
  job: JobRecord,
  result: MediaResult,
  now: number,
  media?: ProcessedMediaDetails,
): ProcessedMedia {
  const sourceId = media?.source.metadata.mediaId;
  return processedMediaSchema.parse({
    id: job.id,
    mediaId:
      typeof sourceId === 'string' && sourceId.length
        ? sourceId
        : (job.sourceFingerprint ?? job.id),
    request: job.request,
    fingerprint: job.sourceFingerprint,
    media: media ?? null,
    createdAt: job.createdAt,
    completedAt: new Date(now).toISOString(),
    result,
  });
}

export function summarizeProcessedMedia(record: ProcessedMedia): ProcessedMediaSummary {
  const { result, ...summary } = record;
  return { ...summary, preview: result.text.slice(0, 240) };
}
