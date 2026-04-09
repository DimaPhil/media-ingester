import { z } from 'zod';

import { operationKinds, providerIds, sourceKinds } from './types';

const baseSourceSchema = z.object({
  kind: z.enum(sourceKinds),
  uri: z.string().trim().min(1),
});

export const remoteSourceSchema = baseSourceSchema.refine(
  (value) => value.kind !== 'local_file',
  {
    message: 'local_file is only supported in CLI local mode',
    path: ['kind'],
  },
);

export const localSourceSchema = baseSourceSchema.extend({
  kind: z.literal('local_file'),
});

const transcriptionProviderSchema = z.enum([
  providerIds[0],
  providerIds[1],
  providerIds[2],
]);

const understandingProviderSchema = z.enum([providerIds[1]]);

export const transcriptionRequestSchema = z.object({
  source: baseSourceSchema,
  provider: transcriptionProviderSchema,
  model: z.string().trim().min(1).optional(),
  inputLanguage: z.string().trim().min(2).max(32).optional(),
  targetLanguage: z.string().trim().min(2).max(32).optional(),
  force: z.boolean().default(false),
});

export const remoteTranscriptionRequestSchema = transcriptionRequestSchema.extend({
  source: remoteSourceSchema,
});

export const understandingRequestSchema = z.object({
  source: baseSourceSchema,
  provider: understandingProviderSchema,
  model: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1),
  force: z.boolean().default(false),
});

export const remoteUnderstandingRequestSchema = understandingRequestSchema.extend({
  source: remoteSourceSchema,
});

export const operationRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal(operationKinds[0]),
    request: transcriptionRequestSchema,
  }),
  z.object({
    kind: z.literal(operationKinds[1]),
    request: understandingRequestSchema,
  }),
]);

export type MediaSourceInput = z.infer<typeof baseSourceSchema>;
export type RemoteMediaSourceInput = z.infer<typeof remoteSourceSchema>;
export type LocalMediaSourceInput = z.infer<typeof localSourceSchema>;
export type TranscriptionRequest = z.infer<typeof transcriptionRequestSchema>;
export type RemoteTranscriptionRequest = z.infer<typeof remoteTranscriptionRequestSchema>;
export type UnderstandingRequest = z.infer<typeof understandingRequestSchema>;
export type RemoteUnderstandingRequest = z.infer<typeof remoteUnderstandingRequestSchema>;
