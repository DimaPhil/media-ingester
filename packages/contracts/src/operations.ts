import { z } from 'zod';
import {
  jobSchema,
  remoteRequestSchema,
  remoteSourceSchema,
  resolvedSourceSchema,
  statusSchema,
  historyInputSchema,
  historyPageSchema,
  processedMediaSchema,
  processedMediaDetailsSchema,
  processedMediaSummarySchema,
} from './media.js';

export const RELEASE_VERSION = '1.4.2';
export const API_VERSION = 'v1';
export const MAX_INLINE_MEDIA_BYTES = 32 * 1024 * 1024;
const idInput = z.object({ id: z.uuid() }).strict();
const empty = z.object({}).strict();
const submit = z
  .object({ request: remoteRequestSchema, idempotencyKey: z.string().min(1).max(200).optional() })
  .strict();
const remoteJobSchema = jobSchema.extend({ request: remoteRequestSchema });
const remoteMediaFields = {
  request: remoteRequestSchema,
  media: processedMediaDetailsSchema
    .extend({ source: resolvedSourceSchema.extend({ source: remoteSourceSchema }) })
    .nullable(),
};
export const operations = {
  submit: {
    method: 'POST',
    path: '/v1/jobs',
    description: 'Queue transcription or media understanding',
    scope: 'media:write',
    input: submit,
    output: remoteJobSchema,
  },
  get: {
    method: 'GET',
    path: '/v1/jobs/:id',
    description: 'Read job status and result',
    scope: 'media:read',
    input: idInput,
    output: remoteJobSchema,
  },
  list: {
    method: 'GET',
    path: '/v1/jobs',
    description: 'List recent jobs',
    scope: 'media:read',
    input: z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        status: statusSchema.optional(),
      })
      .strict(),
    output: z.object({ items: z.array(remoteJobSchema) }),
  },
  retry: {
    method: 'POST',
    path: '/v1/jobs/:id/retry',
    description: 'Retry a failed job using saved chunk results',
    scope: 'media:write',
    input: idInput,
    output: remoteJobSchema,
  },
  history: {
    method: 'GET',
    path: '/v1/history',
    description: 'List retained processing results and media metadata',
    scope: 'media:read',
    input: historyInputSchema,
    output: historyPageSchema.extend({
      items: z.array(processedMediaSummarySchema.extend(remoteMediaFields)),
    }),
  },
  result: {
    method: 'GET',
    path: '/v1/history/:id',
    description: 'Read a retained result by original job ID',
    scope: 'media:read',
    input: idInput,
    output: processedMediaSchema.extend(remoteMediaFields),
  },
  resolve: {
    method: 'POST',
    path: '/v1/sources/resolve',
    description: 'Inspect source metadata',
    scope: 'media:read',
    input: z.object({ source: remoteSourceSchema }).strict(),
    output: resolvedSourceSchema.extend({ source: remoteSourceSchema }),
  },
  upload: {
    method: 'POST',
    path: '/v1/uploads',
    description: 'Upload a local media file (base64, maximum 32 MiB)',
    scope: 'media:write',
    input: z
      .object({
        fileName: z.string().min(1).max(255),
        data: z.string().max(Math.ceil(MAX_INLINE_MEDIA_BYTES / 3) * 4),
      })
      .strict(),
    output: z.object({ source: remoteSourceSchema, size: z.number().int().nonnegative() }),
  },
  download: {
    method: 'POST',
    path: '/v1/downloads',
    description: 'Download source bytes (maximum 32 MiB)',
    scope: 'media:read',
    input: z.object({ source: remoteSourceSchema }).strict(),
    output: z.object({ fileName: z.string(), data: z.string(), mimeType: z.string().optional() }),
  },
  info: {
    method: 'GET',
    path: '/v1/info',
    description: 'Read server version and contract fingerprint',
    scope: null,
    input: empty,
    output: z.object({ version: z.string(), contractHash: z.string() }),
  },
} as const;
export type OperationId = keyof typeof operations;
export type Input<K extends OperationId> = z.input<(typeof operations)[K]['input']>;
export type Output<K extends OperationId> = z.output<(typeof operations)[K]['output']>;
export type Dispatch = <K extends OperationId>(id: K, input: Input<K>) => Promise<Output<K>>;
export const operationIds = Object.keys(operations) as OperationId[];
