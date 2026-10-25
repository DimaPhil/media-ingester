import { z } from 'zod';

export const RELEASE_VERSION = '1.0.0';
export const API_VERSION = 'v1';
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
  kind: z.enum([
    'http',
    'youtube',
    'instagram',
    'x',
    'yt_dlp',
    'google_drive',
    'telegram',
    'upload',
  ]),
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
export const requestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...requestFields,
      kind: z.literal('transcription'),
      source: sourceSchema,
      provider: transcriptionProviderSchema,
    })
    .strict(),
  z
    .object({
      ...requestFields,
      kind: z.literal('understanding'),
      source: sourceSchema,
      provider: understandingProviderSchema,
      prompt: z.string().min(1).max(20000),
    })
    .strict(),
]);
export const remoteRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...requestFields,
      kind: z.literal('transcription'),
      source: remoteSourceSchema,
      provider: transcriptionProviderSchema,
    })
    .strict(),
  z
    .object({
      ...requestFields,
      kind: z.literal('understanding'),
      source: remoteSourceSchema,
      provider: understandingProviderSchema,
      prompt: z.string().min(1).max(20000),
    })
    .strict(),
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
const idInput = z.object({ id: z.uuid() }).strict();
const empty = z.object({}).strict();
const submit = z
  .object({ request: remoteRequestSchema, idempotencyKey: z.string().min(1).max(200).optional() })
  .strict();
const remoteJobSchema = jobSchema.extend({ request: remoteRequestSchema });
export const resolvedSourceSchema = z.object({
  source: sourceSchema,
  fileName: z.string(),
  mimeType: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()),
});
export type ResolvedSource = z.infer<typeof resolvedSourceSchema>;
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
      .object({ fileName: z.string().min(1).max(255), data: z.string().max(44739244) })
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
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
}
export function contractDocument() {
  return operationIds.map((id) => ({
    id,
    ...operations[id],
    input: jsonSchema(operations[id].input),
    output: jsonSchema(operations[id].output),
  }));
}
export function openApiDocument() {
  const paths: Record<string, unknown> = {};
  for (const id of operationIds) {
    const op = operations[id];
    const path = op.path.replace(/:([a-zA-Z]+)/g, '{$1}');
    const input = jsonSchema(op.input);
    const properties = (input.properties ?? {}) as Record<string, unknown>;
    const required = (input.required ?? []) as string[];
    const parameters = Object.entries(properties)
      .filter(([name]) => op.method === 'GET' || op.path.includes(':' + name))
      .map(([name, schema]) => ({
        name,
        in: op.path.includes(':' + name) ? 'path' : 'query',
        required: op.path.includes(':' + name) || required.includes(name),
        schema,
      }));
    paths[path] = {
      ...(paths[path] as object),
      [op.method.toLowerCase()]: {
        operationId: id,
        description: op.description,
        security: [{ bearer: [] }],
        parameters,
        ...(op.method === 'POST'
          ? { requestBody: { required: true, content: { 'application/json': { schema: input } } } }
          : {}),
        responses: {
          '200': {
            description: 'Success',
            content: { 'application/json': { schema: jsonSchema(op.output) } },
          },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Media Ingest API', version: RELEASE_VERSION },
    paths,
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
  };
}
