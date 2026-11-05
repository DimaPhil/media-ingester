import { z } from 'zod';

export const sourceSchema = z
  .object({
    kind: z.enum([
      'http',
      'youtube',
      'instagram',
      'x',
      'yt_dlp',
      'google_drive',
      'telegram',
      'upload',
      'local_file',
    ]),
    uri: z.string().min(1).max(4096),
  })
  .strict();
export const remoteSourceSchema = sourceSchema.extend({
  kind: sourceSchema.shape.kind.exclude(['local_file']),
});
export type Source = z.infer<typeof sourceSchema>;
export const providerSchema = z.enum([
  'openai',
  'google-gemini',
  'google-speech',
  'codex',
  'claude-code',
]);
const transcriptionProviderSchema = z.enum(['openai', 'google-gemini', 'google-speech', 'codex']);
const understandingProviderSchema = z.enum(['google-gemini', 'codex', 'claude-code']);
const requestFields = {
  model: z.string().min(1).max(200).optional(),
  prompt: z.string().min(1).max(20000).optional(),
  inputLanguage: z.string().min(2).max(32).optional(),
  targetLanguage: z.string().min(2).max(32).optional(),
};
const transcriptionRequest = z
  .object({
    ...requestFields,
    kind: z.literal('transcription'),
    source: sourceSchema,
    provider: transcriptionProviderSchema,
  })
  .strict();
const understandingRequest = z
  .object({
    ...requestFields,
    kind: z.literal('understanding'),
    source: sourceSchema,
    provider: understandingProviderSchema,
    prompt: z.string().min(1).max(20000),
  })
  .strict();
export const requestSchema = z.discriminatedUnion('kind', [
  transcriptionRequest,
  understandingRequest,
]);
export const remoteRequestSchema = z.discriminatedUnion('kind', [
  transcriptionRequest.extend({ source: remoteSourceSchema }),
  understandingRequest.extend({ source: remoteSourceSchema }),
]);
export type MediaRequest = z.infer<typeof requestSchema>;
export const segmentSchema = z.object({
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  text: z.string(),
  speaker: z.string().optional(),
});
export const rangeSchema = z.object({
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  label: z.string().optional(),
});
export const provenanceSchema = z.object({
  transcription: z
    .object({ provider: z.literal('codex'), protocol: z.literal('realtime-v3'), model: z.null() })
    .optional(),
  frameIntervalMs: z.number().positive().optional(),
});
export const resultSchema = z.object({
  kind: z.enum(['transcription', 'understanding']),
  text: z.string(),
  segments: z.array(segmentSchema),
  timeRanges: z.array(rangeSchema),
  detectedLanguage: z.string().nullable(),
  translatedText: z.string().optional(),
  provider: providerSchema,
  model: z.string(),
  provenance: provenanceSchema.optional(),
});
export type MediaResult = z.infer<typeof resultSchema>;
export const statusSchema = z.enum(['queued', 'running', 'completed', 'failed']);
export const jobSchema = z.object({
  id: z.uuid(),
  status: statusSchema,
  request: requestSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedChunks: z.number().int().nonnegative(),
  totalChunks: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  result: resultSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
});
export type JobView = z.infer<typeof jobSchema>;
export const resolvedSourceSchema = z.object({
  source: sourceSchema,
  fileName: z.string(),
  mimeType: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()),
});
export type ResolvedSource = z.infer<typeof resolvedSourceSchema>;

export const processedMediaDetailsSchema = z.object({
  source: resolvedSourceSchema,
  sizeBytes: z.number().int().nonnegative().optional(),
  inspection: z.object({
    durationMs: z.number().nonnegative(),
    hasAudio: z.boolean(),
    hasVideo: z.boolean(),
  }),
});
export type ProcessedMediaDetails = z.infer<typeof processedMediaDetailsSchema>;
export const processedMediaSchema = z.object({
  id: z.uuid(),
  mediaId: z.string().min(1),
  request: requestSchema,
  fingerprint: z.string().nullable(),
  media: processedMediaDetailsSchema.nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  result: resultSchema,
});
export type ProcessedMedia = z.infer<typeof processedMediaSchema>;
export const processedMediaSummarySchema = processedMediaSchema
  .omit({ result: true })
  .extend({ preview: z.string().max(240) });
export type ProcessedMediaSummary = z.infer<typeof processedMediaSummarySchema>;
export const historyInputSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    before: z.uuid().optional(),
    mediaId: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type ListHistory = z.infer<typeof historyInputSchema>;
export const historyPageSchema = z.object({
  items: z.array(processedMediaSummarySchema),
  nextBefore: z.uuid().nullable(),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;
