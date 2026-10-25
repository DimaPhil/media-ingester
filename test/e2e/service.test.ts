import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication, contractHash } from '../../apps/api/src/application.js';
import {
  applyMigrations,
  PostgresAuthStore,
  PostgresJobRepository,
} from '../../packages/adapters/src/postgres.js';
import { NodeFiles } from '../../packages/adapters/src/files.js';
import { jobSchema, operationIds, type JobView } from '../../packages/contracts/src/index.js';
import { requireDisposableDatabase } from '../support/database.js';
import {
  MediaSdk,
  type MediaAdapter,
  type ProviderAdapter,
  type SourceAdapter,
} from '../../packages/sdk/dist/index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'E2E requires a disposable PostgreSQL database. Set TEST_DATABASE_URL; see README.md.',
  );
}
requireDisposableDatabase(databaseUrl);
const sql = postgres(databaseUrl, { max: 5, onnotice: () => {} });
const token = 'e2e-private-owner-token-with-more-than-32-characters';
const run = promisify(execFile);
const cliPath = resolve('packages/cli/dist/index.js');
let directory: string;
let baseUrl: string;
let server: ReturnType<typeof serve>;
let application: ReturnType<typeof createApplication>;
let sdk: MediaSdk;
let files: NodeFiles;
let failSecondChunk = false;
const processed: number[] = [];
const sources: SourceAdapter = {
  async resolve(source) {
    return { source, fileName: 'fixture.wav', metadata: { fixture: true } };
  },
  async materialize(source) {
    const path = join(directory, 'source.wav');
    await writeFile(path, 'deterministic media fixture');
    return { uri: path, fileName: source.fileName, fingerprint: 'stable-fixture-v1' };
  },
};
const media: MediaAdapter = {
  async inspect() {
    return { durationMs: 2000, hasAudio: true, hasVideo: true };
  },
  async chunk(artifact, chunk) {
    return { ...artifact, uri: String(chunk.index) };
  },
  async cleanup() {},
};
const provider: ProviderAdapter = {
  resolveModel(request) {
    return request.model ?? 'deterministic-test-model';
  },
  chunkDurationMs() {
    return 1000;
  },
  async process(artifact) {
    const index = Number(artifact.uri);
    processed.push(index);
    if (index === 1 && failSecondChunk) throw new Error('Expected test provider interruption');
    return {
      text: `chunk ${index}`,
      segments: [{ startMs: 0, endMs: 500, text: `chunk ${index}` }],
      timeRanges: [],
      detectedLanguage: 'en',
    };
  },
};
function newSdk() {
  return new MediaSdk({
    repository: new PostgresJobRepository(sql),
    sources,
    media,
    provider,
    chunkConcurrency: 1,
  });
}
async function cli(args: string[], override: NodeJS.ProcessEnv = {}) {
  return run(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, '.config'),
      MEDIA_API_URL: baseUrl,
      MEDIA_API_TOKEN: token,
      ...override,
    },
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
}
async function cliJson(args: string[]): Promise<unknown> {
  return JSON.parse((await cli(args)).stdout);
}
function rpc(
  method: string,
  params: Record<string, unknown> = {},
  version = '2026-07-28',
  authorization = token,
) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${authorization}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': version,
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
          'io.modelcontextprotocol/protocolVersion': version,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'media-e2e', version: '1.0.0' },
        },
      },
    }),
  });
}

beforeAll(async () => {
  await readFile(cliPath); // Fail early if the build step was omitted.
  directory = await mkdtemp(join(tmpdir(), 'media-e2e-'));
  files = new NodeFiles({ workRoot: join(directory, 'storage') });
  await applyMigrations(sql);
  await new Promise<void>((done) => {
    server = serve(
      { fetch: (request) => application.app.fetch(request), hostname: '127.0.0.1', port: 0 },
      (address) => {
        baseUrl = `http://127.0.0.1:${address.port}`;
        sdk = newSdk();
        application = createApplication({
          sdk,
          sources,
          media,
          publicUrl: baseUrl,
          ownerToken: token,
          authStore: new PostgresAuthStore(sql),
          files,
        });
        done();
      },
    );
  });
});

beforeEach(async () => {
  await sql`TRUNCATE media_v1.jobs, media_v1.auth_entries`;
  processed.length = 0;
  failSecondChunk = false;
});

afterAll(async () => {
  await application?.close();
  if (server)
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  await sql.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('real HTTP, CLI and durable worker', () => {
  it('uploads a local file through the CLI, processes persisted jobs, and reads results over HTTP', async () => {
    const fixture = join(directory, 'input.wav');
    await writeFile(fixture, 'fixture bytes');
    const upload = (await cliJson(['upload', fixture])) as {
      source: { kind: string; uri: string };
      size: number;
    };
    expect(upload.source.kind).toBe('upload');
    expect(
      await readFile((await files.uploadMetadata('owner', upload.source.uri)).path, 'utf8'),
    ).toBe('fixture bytes');
    const queued = jobSchema.parse(
      await cliJson(['transcribe', fixture, '--idempotency-key', 'local-fixture']),
    );
    expect(queued.status).toBe('queued');
    expect(queued.request.source.kind).toBe('upload');
    const repeated = jobSchema.parse(
      await cliJson(['transcribe', fixture, '--idempotency-key', 'local-fixture']),
    );
    expect(repeated.id).toBe(queued.id);
    expect(await sdk.runNext()).toBe(true);
    const result = jobSchema.parse(await cliJson(['get', queued.id]));
    expect(result.status).toBe('completed');
    expect(result.result?.text).toBe('chunk 0 chunk 1');
    expect(result.result?.segments.map((segment) => segment.startMs)).toEqual([0, 1000]);
    const listed = (await cliJson(['list'])) as { items: JobView[] };
    expect(listed.items.map((item) => item.id)).toEqual([queued.id]);
    const durable = await new PostgresJobRepository(sql).get('owner', queued.id);
    expect(Object.keys(durable!.chunks)).toEqual(['0', '1']);
    expect(await sdk.runNext()).toBe(false);
  });

  it('resumes completed chunks after a provider failure and a fresh worker instance', async () => {
    failSecondChunk = true;
    const queued = jobSchema.parse(
      await cliJson([
        'transcribe',
        'https://example.com/media.wav',
        '--idempotency-key',
        'retry-fixture',
      ]),
    );
    await sdk.runNext();
    const failed = jobSchema.parse(await cliJson(['get', queued.id]));
    expect(failed.status).toBe('failed');
    expect(failed.completedChunks).toBe(1);
    expect(processed).toEqual([0, 1]);
    const retried = jobSchema.parse(await cliJson(['retry', queued.id]));
    expect(retried.status).toBe('queued');
    failSecondChunk = false;
    const restartedWorker = newSdk();
    await restartedWorker.runNext();
    expect(processed).toEqual([0, 1, 1]);
    const completed = jobSchema.parse(await cliJson(['get', queued.id]));
    expect(completed.status).toBe('completed');
    expect(completed.attempt).toBe(2);
    await expect(cli(['retry', queued.id])).rejects.toMatchObject({ code: 1 });
  });

  it('deduplicates concurrent submissions and rejects changed requests with the same key', async () => {
    const args = [
      'transcribe',
      'https://example.com/media.wav',
      '--idempotency-key',
      'concurrent-key',
    ];
    const jobs = await Promise.all([cliJson(args), cliJson(args)]);
    expect(jobSchema.parse(jobs[0]).id).toBe(jobSchema.parse(jobs[1]).id);
    await expect(cli([...args, '--model', 'different-model'])).rejects.toMatchObject({ code: 1 });
    expect((await new PostgresJobRepository(sql).list('owner', { limit: 100 })).length).toBe(1);
  });

  it('rejects unauthenticated, cross-origin, local filesystem and stale-contract requests', async () => {
    expect((await fetch(`${baseUrl}/v1/jobs`)).status).toBe(401);
    await expect(cli(['list'], { MEDIA_API_TOKEN: 'wrong-token' })).rejects.toMatchObject({
      code: 1,
    });
    const maliciousOrigin = await fetch(`${baseUrl}/v1/jobs`, {
      headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' },
    });
    expect(maliciousOrigin.status).toBe(403);
    const body = {
      request: {
        kind: 'transcription',
        source: { kind: 'local_file', uri: '/etc/passwd' },
        provider: 'openai',
      },
    };
    const localPath = await fetch(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(localPath.status).toBe(400);
    const drift = await fetch(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-media-contract': 'obsolete',
      },
      body: JSON.stringify(body),
    });
    expect(drift.status).toBe(409);
    const info = (await cliJson(['info'])) as { contractHash: string };
    expect(info.contractHash).toBe(contractHash);
  });
});

describe('current MCP transport and owner-approved OAuth', () => {
  it('discovers the current protocol and exposes exactly the REST operation catalog', async () => {
    const discovery = await rpc('server/discover');
    expect(discovery.status).toBe(200);
    const discovered = await discovery.json();
    expect(discovered.result.supportedVersions).toContain('2026-07-28');
    const list = await rpc('tools/list');
    expect(list.status).toBe(200);
    const toolList = await list.json();
    expect(toolList.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(
      operationIds.map((id) => `media_${id}`).sort(),
    );
    const call = await rpc('tools/call', { name: 'media_info', arguments: {} });
    expect(call.status).toBe(200);
    expect((await call.json()).result.structuredContent.contractHash).toBe(contractHash);
    const unsupported = await rpc('server/discover', {}, '1900-01-01');
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).error.code).toBe(-32022);
  });

  it('registers a native OAuth client, requires owner approval and binds its read-only token to MCP', async () => {
    const registration = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'E2E native client',
        application_type: 'native',
        redirect_uris: ['http://127.0.0.1:54321/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(registration.status).toBe(201);
    const client = await registration.json();
    const verifier = 'e2e-pkce-verifier-with-more-than-forty-three-characters';
    const authorization = new URL(`${baseUrl}/oauth/authorize`);
    authorization.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1:54321/callback',
      response_type: 'code',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      resource: `${baseUrl}/mcp`,
      scope: 'media:read',
      state: 'test-state',
    }).toString();
    const consentResponse = await fetch(authorization);
    expect(consentResponse.status).toBe(200);
    const consent = /name="consent" value="([^"]+)"/.exec(await consentResponse.text())?.[1];
    expect(consent).toBeTruthy();
    const approval = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: baseUrl,
        cookie: consentResponse.headers.get('set-cookie')!.split(';')[0]!,
      },
      body: new URLSearchParams({ consent: consent!, owner_token: token, decision: 'approve' }),
    });
    expect(approval.status).toBe(303);
    const callback = new URL(approval.headers.get('location')!);
    expect(callback.searchParams.get('state')).toBe('test-state');
    expect(callback.searchParams.get('iss')).toBe(baseUrl);
    const exchange = new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code')!,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1:54321/callback',
      resource: `${baseUrl}/mcp`,
    });
    const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: exchange,
    });
    expect(tokenResponse.status).toBe(200);
    const access = await tokenResponse.json();
    const tools = await rpc('tools/list', {}, '2026-07-28', access.access_token);
    const names = (await tools.json()).result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('media_get');
    expect(names).not.toContain('media_submit');
    const replay = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: exchange,
    });
    expect(replay.status).toBe(400);
    const apiRequest = await fetch(`${baseUrl}/v1/jobs`, {
      headers: { authorization: `Bearer ${access.access_token}` },
    });
    expect(apiRequest.status).toBe(401);
  });
});
