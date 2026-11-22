import { describe, it, expect } from 'vitest';
import {
  operations,
  operationIds,
  openApiDocument,
  contractDocument,
  requestSchema,
  resultSchema,
  jobSchema,
  operationNameSchema,
} from '../src/index.js';
describe('wire contract', () => {
  it('exposes subscription understanding while attributing standalone ASR only to Codex', () => {
    for (const provider of ['codex', 'claude-code']) {
      const request = {
        kind: 'understanding',
        provider,
        prompt: 'Describe',
        source: { kind: 'upload', uri: 'clip' },
      };
      expect(operations.submit.input.safeParse({ request }).success).toBe(true);
      expect(JSON.stringify(openApiDocument())).toContain(JSON.stringify(provider));
      expect(
        operations.submit.input.safeParse({ request: { ...request, prompt: undefined } }).success,
      ).toBe(false);
      expect(
        operations.submit.input.safeParse({ request: { ...request, kind: 'transcription' } })
          .success,
      ).toBe(provider === 'codex');
    }
  });
  it.each(['youtube', 'instagram', 'x', 'yt_dlp'])(
    'exposes %s sources through every generated contract',
    (kind) => {
      const request = {
        kind: 'transcription',
        provider: 'openai',
        source: { kind, uri: 'https://example.com/video' },
      };
      expect(operations.submit.input.safeParse({ request }).success).toBe(true);
      expect(JSON.stringify(openApiDocument())).toContain(JSON.stringify(kind));
    },
  );
  it('emits each catalog operation exactly once with path parameters and schemas', () => {
    const spec = openApiDocument();
    const descriptors = Object.values(spec.paths).flatMap((path) =>
      Object.values(path as Record<string, any>),
    );
    expect(descriptors.map((op) => op.operationId).sort()).toEqual([...operationIds].sort());
    expect((spec.paths['/v1/jobs/{id}'] as any).get.parameters).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    ]);
    expect(contractDocument()).toHaveLength(operationIds.length);
    expect(JSON.stringify(spec)).not.toContain('local_file');
  });
  it('rejects local paths and inconsistent understanding requests at the remote boundary', () => {
    const request = {
      kind: 'transcription',
      provider: 'openai',
      source: { kind: 'local_file', uri: '/private/file' },
    };
    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(operations.submit.input.safeParse({ request }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, kind: 'understanding' }).success).toBe(false);
    expect(
      requestSchema.safeParse({
        ...request,
        kind: 'understanding',
        provider: 'google-gemini',
        prompt: 'Summarize',
      }).success,
    ).toBe(true);
    expect(requestSchema.safeParse({ ...request, unknown: true }).success).toBe(false);
    expect(resultSchema.safeParse({ kind: 'transcription' }).success).toBe(false);
  });
  it('names next-step operations from the catalog and keeps job additions optional', () => {
    expect(operationNameSchema.options).toEqual(operationIds);
    const legacy = {
      id: '00000000-0000-4000-8000-000000000000',
      status: 'failed',
      request: { kind: 'transcription', provider: 'openai', source: { kind: 'upload', uri: 'a' } },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      completedChunks: 1,
      totalChunks: 2,
      attempt: 1,
      result: null,
      error: { code: 'processing_failed', message: 'failed', retryable: true },
    };
    expect(jobSchema.safeParse(legacy).success).toBe(true);
    const current = {
      ...legacy,
      stage: 'failed',
      error: {
        ...legacy.error,
        details: { provider: 'openai', chunkIndex: 1, retryAfter: null, blocked: false },
        nextSteps: [{ operation: 'retry', input: { id: legacy.id }, reason: 'Transient' }],
      },
    };
    expect(jobSchema.parse(current)).toEqual(current);
    expect(
      jobSchema.safeParse({ ...current, error: { ...current.error, details: { nested: {} } } })
        .success,
    ).toBe(false);
    expect(
      jobSchema.safeParse({
        ...current,
        nextSteps: [{ operation: 'delete', input: {}, reason: 'x' }],
      }).success,
    ).toBe(false);
  });
});
