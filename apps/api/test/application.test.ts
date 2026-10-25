import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MediaError,
  MediaSdk,
  type MediaAdapter,
  type ProviderAdapter,
  type SourceAdapter,
} from '@media-ingest/sdk';
import { operationIds, type JobView, type Source } from '@media-ingest/contracts';
import { createApplication, contractHash } from '../src/application.js';
import { MemoryAuthStore } from '../src/auth/index.js';
import { MediaClient } from '../../../packages/client/src/index.js';

const publicUrl = 'http://localhost:4000';
const ownerToken = 'unit-test-owner-token-with-at-least-thirty-two-characters';
const source: Source = { kind: 'http', uri: 'https://example.com/media.wav' };
let directory: string;
let artifactPath: string;
let application: ReturnType<typeof createApplication>;
let sdk: MediaSdk;
let authStore: MemoryAuthStore;
const cleanup = vi.fn<MediaAdapter['cleanup']>(async () => {});
const resolveSource = vi.fn<SourceAdapter['resolve']>(async (input) => ({
  source: input,
  fileName: 'media.wav',
  metadata: {},
}));
const materialize = vi.fn<SourceAdapter['materialize']>(async () => ({
  uri: artifactPath,
  fileName: 'media.wav',
  mimeType: 'audio/wav',
  fingerprint: 'stable',
}));
const sources: SourceAdapter = { resolve: resolveSource, materialize };
const media: MediaAdapter = {
  inspect: async () => ({ durationMs: 1000, hasAudio: true, hasVideo: false }),
  chunk: async (artifact) => artifact,
  cleanup,
};
const processChunk = vi.fn<ProviderAdapter['process']>(async () => ({
  text: 'transcript',
  segments: [],
  timeRanges: [],
  detectedLanguage: 'en',
}));
const provider: ProviderAdapter = {
  resolveModel: () => 'fixture-model',
  chunkDurationMs: () => 1000,
  process: processChunk,
};
const upload = vi.fn(async () => ({ source: { kind: 'upload', uri: randomUUID() }, size: 3 }));
const report = vi.fn();

function request(path: string, init: RequestInit = {}, authenticated = true) {
  return application.app.request(`${publicUrl}${path}`, {
    ...init,
    headers: {
      host: 'localhost:4000',
      ...(authenticated ? { authorization: `Bearer ${ownerToken}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  request(path, { method: 'POST', body: JSON.stringify(body), headers });
async function submit(): Promise<JobView> {
  const response = await post('/v1/jobs', {
    request: { kind: 'transcription', source, provider: 'openai' },
  });
  expect(response.status).toBe(200);
  return response.json();
}
function mcp(method: string, params: Record<string, unknown> = {}, token = ownerToken) {
  return request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(method === 'tools/call' ? { 'Mcp-Name': String(params.name) } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  resolveSource
    .mockReset()
    .mockImplementation(async (input) => ({ source: input, fileName: 'media.wav', metadata: {} }));
  materialize.mockReset().mockImplementation(async () => ({
    uri: artifactPath,
    fileName: 'media.wav',
    mimeType: 'audio/wav',
    fingerprint: 'stable',
  }));
  processChunk.mockReset().mockResolvedValue({
    text: 'transcript',
    segments: [],
    timeRanges: [],
    detectedLanguage: 'en',
  });
  upload
    .mockReset()
    .mockImplementation(async () => ({ source: { kind: 'upload', uri: randomUUID() }, size: 3 }));
  directory = await mkdtemp(join(tmpdir(), 'media-api-unit-'));
  artifactPath = join(directory, 'fixture.wav');
  await writeFile(artifactPath, 'fixture');
  sdk = new MediaSdk({ sources, media, provider });
  authStore = new MemoryAuthStore();
  application = createApplication({
    sdk,
    sources,
    media,
    files: { upload },
    publicUrl,
    ownerToken,
    authStore,
    allowedOrigins: ['https://trusted.example'],
    logger: report,
  });
});
afterEach(async () => {
  await application.close();
  await rm(directory, { recursive: true, force: true });
});

describe('application security boundary', () => {
  it('lets write-only HTTP clients preflight metadata and mutate without granting read access', async () => {
    const token = 'write-only-test-token';
    const expiresAt = Date.now() + 60000;
    await authStore.put(
      `token:${createHash('sha256').update(token).digest('hex')}`,
      { resource: publicUrl, scopes: ['media:write'], expiresAt },
      expiresAt,
    );
    const client = new MediaClient({
      baseUrl: publicUrl,
      token,
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('host', 'localhost:4000');
        return application.app.request(String(url), { ...init, headers });
      },
    });
    const job = await client.call('submit', {
      request: { kind: 'transcription', source, provider: 'openai' },
    });
    expect(job.status).toBe('queued');
    await expect(client.call('get', { id: job.id })).rejects.toMatchObject({ status: 403 });
    expect((await request('/v1/info', {}, false)).status).toBe(401);
  });
  it('rejects unauthenticated streaming bodies before reading them', async () => {
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const incoming = new Request(`${publicUrl}/v1/uploads`, {
      method: 'POST',
      body,
      duplex: 'half',
      headers: { host: 'localhost:4000' },
    } as RequestInit);
    const response = await application.app.fetch(incoming);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      `${publicUrl}/.well-known/oauth-protected-resource`,
    );
    expect(incoming.bodyUsed).toBe(false);
    expect(pull).not.toHaveBeenCalled();
    await body.cancel();
  });

  it('enforces host/origin, permits health and discovery without credentials, and emits security headers', async () => {
    expect((await request('/v1/info', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect(
      (await request('/healthz', { headers: { host: 'container-internal' } }, false)).status,
    ).toBe(200);
    expect(
      (await request('/v1/info', { headers: { origin: 'https://evil.example' } })).status,
    ).toBe(403);
    expect(
      (await request('/v1/info', { headers: { origin: 'https://trusted.example' } })).status,
    ).toBe(200);
    expect((await request('/v1/info', { headers: { origin: publicUrl } })).status).toBe(200);
    const metadata = await request('/.well-known/oauth-authorization-server', {}, false);
    expect(metadata.status).toBe(200);
    const info = await request('/v1/info');
    expect(info.headers.get('x-content-type-options')).toBe('nosniff');
    expect(info.headers.get('cache-control')).toBe('no-store');
    expect(info.headers.get('x-media-contract')).toBe(contractHash);
    expect(await info.json()).toEqual({ version: '1.0.0', contractHash });
    expect((await request('/mcp', {}, false)).status).toBe(401);
  });

  it('bounds authenticated request bodies and rejects stale contract writes', async () => {
    const tooLarge = await request('/v1/uploads', {
      method: 'POST',
      headers: { 'content-length': String(47 * 1024 * 1024) },
      body: '{}',
    });
    expect(tooLarge.status).toBe(413);
    const drift = await post('/v1/jobs', {}, { 'x-media-contract': 'stale' });
    expect(drift.status).toBe(409);
    expect((await drift.json()).error.code).toBe('contract_mismatch');
    expect(
      (
        await post(
          '/v1/uploads',
          { fileName: 'a.wav', data: 'YWJj' },
          { 'x-media-contract': contractHash },
        )
      ).status,
    ).toBe(200);
  });
});

describe('catalog-backed REST operations', () => {
  it('publishes every operation and submits/gets/lists/retries a job through common validation', async () => {
    const spec = await (await request('/openapi.json')).json();
    const ids = Object.values(spec.paths).flatMap((path) =>
      Object.values(path as Record<string, { operationId: string }>).map(
        (operation) => operation.operationId,
      ),
    );
    expect(ids.sort()).toEqual([...operationIds].sort());
    const job = await submit();
    expect((await (await request(`/v1/jobs/${job.id}`)).json()).id).toBe(job.id);
    const list = await (await request('/v1/jobs?limit=1&status=queued')).json();
    expect(list.items.map((item: JobView) => item.id)).toEqual([job.id]);
    processChunk.mockRejectedValueOnce(new Error('provider secret'));
    await sdk.runNext();
    const retry = await post(`/v1/jobs/${job.id}/retry`, {});
    expect(retry.status).toBe(200);
    expect((await retry.json()).status).toBe('queued');
    expect((await post(`/v1/jobs/${job.id}/retry`, { id: job.id })).status).toBe(409);
    expect((await request(`/v1/jobs/${randomUUID()}`)).status).toBe(404);
  });

  it('rejects malformed inputs without dispatching', async () => {
    expect(
      (
        await request('/v1/jobs', {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'text/plain' },
        })
      ).status,
    ).toBe(415);
    expect((await request('/v1/jobs', { method: 'POST', body: '{' })).status).toBe(400);
    for (const body of [null, [], 'string'])
      expect((await post('/v1/jobs', body)).status).toBe(400);
    const invalid = await post('/v1/jobs', {
      request: {
        kind: 'transcription',
        source: { kind: 'local_file', uri: '/etc/passwd' },
        provider: 'openai',
      },
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.issues.length).toBeGreaterThan(0);
    expect((await post(`/v1/jobs/${randomUUID()}/retry`, { id: randomUUID() })).status).toBe(400);
    expect((await request('/v1/jobs?limit=101')).status).toBe(400);
    await expect(application.dispatch('owner', [], 'list', {})).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('resolves sources and uploads using the authenticated owner', async () => {
    const resolved = await post('/v1/sources/resolve', { source });
    expect(resolved.status).toBe(200);
    expect((await resolved.json()).source).toEqual(source);
    expect(resolveSource.mock.calls[0]![1]).toMatchObject({ ownerId: 'owner', attempt: 0 });
    const uploaded = await post('/v1/uploads', { fileName: 'a.wav', data: 'YWJj' });
    expect(uploaded.status).toBe(200);
    expect(upload).toHaveBeenCalledWith('owner', 'a.wav', 'YWJj');
  });

  it('maps domain errors and sanitizes backend failures and invalid output', async () => {
    for (const [code, status] of [
      ['forbidden', 403],
      ['invalid_state', 409],
      ['invalid_request', 400],
    ] as const) {
      resolveSource.mockRejectedValueOnce(new MediaError(code, 'Safe message'));
      expect((await post('/v1/sources/resolve', { source })).status).toBe(status);
    }
    const secret = 'postgres://private-secret@database';
    resolveSource.mockRejectedValueOnce(new Error(secret));
    const failed = await post('/v1/sources/resolve', { source });
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain(secret);
    expect(report).toHaveBeenCalled();
    upload.mockResolvedValueOnce({ source: { kind: 'upload', uri: randomUUID() }, size: -1 });
    const invalidOutput = await post('/v1/uploads', { fileName: 'a', data: 'YQ==' });
    expect(invalidOutput.status).toBe(500);
    expect((await invalidOutput.json()).error.code).toBe('internal_error');
  });
});

describe('download lifecycle', () => {
  it('returns bounded file content and cleans the materialization workspace', async () => {
    const response = await post('/v1/downloads', { source });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      fileName: 'media.wav',
      data: Buffer.from('fixture').toString('base64'),
      mimeType: 'audio/wav',
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup.mock.calls[0]![0]).toMatchObject({ ownerId: 'owner', attempt: 0 });
  });

  it('cleans up oversized media and failed downloads', async () => {
    await truncate(artifactPath, 33 * 1024 * 1024);
    expect((await post('/v1/downloads', { source })).status).toBe(413);
    expect(cleanup).toHaveBeenCalledOnce();
    materialize.mockRejectedValueOnce(new Error('sensitive source failure'));
    const failed = await post('/v1/downloads', { source });
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain('sensitive');
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});

describe('MCP uses the same dispatcher', () => {
  it('serves tool discovery and structured results and sanitizes tool failures', async () => {
    const list = await mcp('tools/list');
    expect(list.status).toBe(200);
    expect((await list.json()).result.tools).toHaveLength(operationIds.length);
    const info = await mcp('tools/call', { name: 'media_info', arguments: {} });
    expect((await info.json()).result.structuredContent.contractHash).toBe(contractHash);
    const missing = await mcp('tools/call', { name: 'media_get', arguments: { id: randomUUID() } });
    const missingValue = await missing.json();
    expect(missingValue.result.isError).toBe(true);
    expect(missingValue.result.content[0].text).toBe('Job not found');
    resolveSource.mockRejectedValueOnce(new Error('provider password'));
    const failed = await mcp('tools/call', { name: 'media_resolve', arguments: { source } });
    expect((await failed.json()).result.content[0].text).toBe(
      'Request failed validation or processing',
    );
  });
});
