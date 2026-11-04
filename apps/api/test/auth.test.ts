import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createAuth, MemoryAuthStore } from '../src/auth/index.js';
import { fetchClientMetadata, isPublicIpv4, metadataUrl } from '../src/auth/metadata.js';

const network = vi.hoisted(() => ({ resolve4: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ resolve4: network.resolve4 }));
vi.mock('node:https', () => ({ request: network.request }));

const issuer = 'https://media.example.com';
const ownerToken = 'test-owner-token-'.repeat(4);
const verifier = 'a'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const redirectUri = 'https://client.example.com/callback';

function setup() {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const store = new MemoryAuthStore(now);
  const fetchClientMetadata = vi.fn(async (clientId: string) => ({
    client_id: clientId,
    client_name: 'Metadata client',
    redirect_uris: [redirectUri],
  }));
  const auth = createAuth({ publicUrl: issuer, ownerToken, store, now, fetchClientMetadata });
  const call = async (path: string, init?: RequestInit) => {
    const response = await auth.handle(new Request(`${issuer}${path}`, init));
    if (!response) throw new Error('Unexpected unhandled route');
    return response;
  };
  const form = (values: Record<string, string>, headers?: Record<string, string>): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(values),
  });
  const register = async (extra: Record<string, unknown> = {}) => {
    const response = await call('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Test client', redirect_uris: [redirectUri], ...extra }),
    });
    return { response, value: (await response.json()) as { client_id: string; error?: string } };
  };
  const authorize = async (clientId: string, extra: Record<string, string> = {}) => {
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      resource: `${issuer}/mcp`,
      response_type: 'code',
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: 'media:read media:write',
      state: 'state-123',
      ...extra,
    });
    const response = await call(`/oauth/authorize?${query}`);
    const html = await response.text();
    return {
      response,
      html,
      consent: /name="consent" value="([^"]+)"/.exec(html)?.[1] ?? '',
      cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
    };
  };
  const approve = async (
    consent: string,
    cookie: string,
    extra: Record<string, string> = {},
    origin = issuer,
  ) =>
    call(
      '/oauth/authorize',
      form({ consent, owner_token: ownerToken, decision: 'approve', ...extra }, { origin, cookie }),
    );
  const code = async (clientId?: string) => {
    const actualId = clientId ?? (await register()).value.client_id;
    const consent = await authorize(actualId);
    const response = await approve(consent.consent, consent.cookie);
    expect(response.status).toBe(303);
    return {
      clientId: actualId,
      code: new URL(response.headers.get('location')!).searchParams.get('code')!,
    };
  };
  const exchange = (clientId: string, codeValue: string, extra: Record<string, string> = {}) =>
    call(
      '/oauth/token',
      form({
        grant_type: 'authorization_code',
        code: codeValue,
        client_id: clientId,
        redirect_uri: redirectUri,
        resource: `${issuer}/mcp`,
        code_verifier: verifier,
        ...extra,
      }),
    );
  return {
    auth,
    store,
    call,
    form,
    register,
    authorize,
    approve,
    code,
    exchange,
    fetchClientMetadata,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('private service authentication', () => {
  it('requires a strong owner token and secure issuer', () => {
    const store = new MemoryAuthStore();
    expect(() => createAuth({ publicUrl: issuer, ownerToken: 'short', store })).toThrow('32');
    expect(() => createAuth({ publicUrl: 'http://public.example.com', ownerToken, store })).toThrow(
      'HTTPS',
    );
    expect(() => createAuth({ publicUrl: `${issuer}/prefix`, ownerToken, store })).toThrow('HTTPS');
    expect(() =>
      createAuth({ publicUrl: 'http://localhost:4000', ownerToken, store }),
    ).not.toThrow();
  });
  it('authenticates owner API tokens and rejects malformed, wrong or missing credentials', async () => {
    const { auth } = setup();
    expect(await auth.authenticate(new Request(issuer))).toBeNull();
    expect(
      await auth.authenticate(new Request(issuer, { headers: { authorization: 'Basic abc' } })),
    ).toBeNull();
    expect(
      await auth.authenticate(new Request(issuer, { headers: { authorization: 'Bearer wrong' } })),
    ).toBeNull();
    expect(
      await auth.authenticate(
        new Request(issuer, { headers: { authorization: `Bearer ${'a'.repeat(4097)}` } }),
      ),
    ).toBeNull();
    expect(
      await auth.authenticate(
        new Request(issuer, { headers: { authorization: `Bearer ${ownerToken}` } }),
      ),
    ).toEqual({ ownerId: 'owner', scopes: ['media:read', 'media:write'] });
    expect(auth.challenge().headers.get('www-authenticate')).toContain(
      '/.well-known/oauth-protected-resource/mcp',
    );
    expect(auth.challenge(issuer).headers.get('www-authenticate')).not.toContain('/mcp');
    expect(await auth.handle(new Request(`${issuer}/unrelated`))).toBeNull();
  });
  it('publishes issuer and protected-resource discovery', async () => {
    const { call } = setup();
    const metadata = await (await call('/.well-known/oauth-authorization-server')).json();
    expect(metadata).toMatchObject({
      issuer,
      client_id_metadata_document_supported: true,
      registration_endpoint: `${issuer}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
    });
    expect(await (await call('/.well-known/oauth-protected-resource/mcp')).json()).toMatchObject({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
    });
    expect(await (await call('/.well-known/oauth-protected-resource')).json()).toMatchObject({
      resource: issuer,
    });
    const preflight = await call('/oauth/token', { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  });
  it('registers native loopback clients but never grants access during registration', async () => {
    const { register, auth } = setup();
    const { response, value } = await register({
      application_type: 'native',
      redirect_uris: [
        'http://localhost:8123/callback',
        'http://127.0.0.1:8123/callback',
        'http://[::1]:8123/callback',
      ],
    });
    expect(response.status).toBe(201);
    expect(
      await auth.authenticate(
        new Request(issuer, { headers: { authorization: `Bearer ${value.client_id}` } }),
      ),
    ).toBeNull();
    for (const extra of [
      { redirect_uris: ['http://localhost/callback'] },
      { redirect_uris: ['https://client.example.com/callback#fragment'] },
      { redirect_uris: ['https://user:password@client.example.com/callback'] },
      { redirect_uris: [] },
      { client_name: '' },
      { application_type: 'other' },
      { token_endpoint_auth_method: 'client_secret_basic' },
      { grant_types: ['refresh_token'] },
      { response_types: ['token'] },
    ])
      expect((await register(extra)).response.status).toBe(400);
  });
  it('validates authorization redirect, resource, scope and PKCE before displaying consent', async () => {
    const { register, authorize, call } = setup();
    const clientId = (await register()).value.client_id;
    for (const extra of [
      { redirect_uri: 'https://evil.example.com/callback' },
      { resource: 'https://other.example.com/mcp' },
      { scope: 'admin' },
      { scope: '' },
      { response_type: 'token' },
      { code_challenge_method: 'plain' },
      { code_challenge: 'short' },
      { state: 'a'.repeat(4097) },
    ] as Record<string, string>[])
      expect((await authorize(clientId, extra)).response.status).toBe(400);
    expect((await authorize('unknown-client')).response.status).toBe(400);
    expect((await call('/oauth/authorize?client_id=one&client_id=two')).status).toBe(400);
  });
  it('requires owner approval, same-origin POST and matching HttpOnly browser cookie', async () => {
    const { register, authorize, approve } = setup();
    const consent = await authorize(
      (await register({ client_name: '<script>alert(1)</script>' })).value.client_id,
    );
    expect(consent.html).toContain('&lt;script&gt;');
    expect(consent.html).not.toContain('<script>');
    expect(consent.response.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
    expect(consent.response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(consent.response.headers.get('set-cookie')).toContain('Secure');
    expect(
      (await approve(consent.consent, consent.cookie, {}, 'https://evil.example.com')).status,
    ).toBe(403);
    expect((await approve(consent.consent, '')).status).toBe(403);
    expect((await approve(consent.consent, consent.cookie, { owner_token: 'wrong' })).status).toBe(
      403,
    );
    const granted = await approve(consent.consent, consent.cookie);
    expect(granted.status).toBe(303);
    const redirect = new URL(granted.headers.get('location')!);
    expect(redirect.searchParams.get('iss')).toBe(issuer);
    expect(redirect.searchParams.get('state')).toBe('state-123');
    expect((await approve(consent.consent, consent.cookie)).status).toBe(403);
  });
  it('supports explicit denial and expires consent', async () => {
    const { register, authorize, approve, advance } = setup();
    const clientId = (await register()).value.client_id;
    const consent = await authorize(clientId);
    const denied = await approve(consent.consent, consent.cookie, {
      decision: 'deny',
      owner_token: '',
    });
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe(
      'access_denied',
    );
    const stale = await authorize(clientId);
    advance(600001);
    expect((await approve(stale.consent, stale.cookie)).status).toBe(403);
  });
  it('issues scoped opaque tokens with audience binding, expiry and revocation', async () => {
    const { code, exchange, auth, call, form, advance } = setup();
    const grant = await code();
    const response = await exchange(grant.clientId, grant.code);
    expect(response.status).toBe(200);
    const token = (await response.json()) as { access_token: string; scope: string };
    const request = new Request(issuer, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(await auth.authenticate(request)).toEqual({
      ownerId: 'owner',
      scopes: ['media:read', 'media:write'],
    });
    expect(await auth.authenticate(request, issuer)).toBeNull();
    expect((await exchange(grant.clientId, grant.code)).status).toBe(400);
    expect((await call('/oauth/revoke', form({ token: token.access_token }))).status).toBe(200);
    expect(await auth.authenticate(request)).toBeNull();
    const laterGrant = await code();
    const later = (await (await exchange(laterGrant.clientId, laterGrant.code)).json()) as {
      access_token: string;
    };
    advance(3600001);
    expect(
      await auth.authenticate(
        new Request(issuer, { headers: { authorization: `Bearer ${later.access_token}` } }),
      ),
    ).toBeNull();
  });
  it('rejects wrong verifier, client, redirect, audience and expired codes', async () => {
    const { code, exchange, advance } = setup();
    for (const extra of [
      { code_verifier: 'short' },
      { code_verifier: 'b'.repeat(64) },
      { client_id: 'wrong' },
      { redirect_uri: 'https://evil.example.com/callback' },
      { resource: issuer },
      { grant_type: 'refresh_token' },
    ] as Record<string, string>[]) {
      const grant = await code();
      expect((await exchange(grant.clientId, grant.code, extra)).status).toBe(400);
    }
    const expired = await code();
    advance(60001);
    expect((await exchange(expired.clientId, expired.code)).status).toBe(400);
  });
  it('supports CIMD with exact client_id binding', async () => {
    const { authorize, fetchClientMetadata, code, exchange } = setup();
    const clientId = 'https://client.example.com/client.json';
    const grant = await code(clientId);
    expect(fetchClientMetadata).toHaveBeenCalledWith(clientId);
    expect((await exchange(grant.clientId, grant.code)).status).toBe(200);
    fetchClientMetadata.mockResolvedValueOnce({
      client_id: 'https://other.example.com/client.json',
      client_name: 'Mismatch',
      redirect_uris: [redirectUri],
    });
    expect((await authorize(clientId)).response.status).toBe(400);
    expect((await authorize('https://127.0.0.1/client.json')).response.status).toBe(400);
  });
  it('bounds registration input and rate limits public auth work', async () => {
    const { call } = setup();
    expect((await call('/oauth/register', { method: 'POST', body: '{}' })).status).toBe(400);
    expect(
      (
        await call('/oauth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': '70000' },
          body: '{}',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('/oauth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'a'.repeat(70000),
        })
      ).status,
    ).toBe(400);
    expect((await call('/oauth/token', { method: 'POST', body: 'x' })).status).toBe(400);
    expect(
      (
        await call('/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'code=a&code=b',
        })
      ).status,
    ).toBe(400);
    expect((await call('/oauth/revoke', { method: 'POST', body: 'x' })).status).toBe(400);
    expect(
      (await call('/oauth/authorize', { method: 'POST', headers: { origin: issuer }, body: 'x' }))
        .status,
    ).toBe(400);
    expect((await call('/oauth/register')).status).toBe(405);
    for (let index = 0; index < 60; index++) await call('/oauth/register');
    expect((await call('/oauth/register')).status).toBe(429);
  });
});

describe('auth persistence and client metadata network boundary', () => {
  it('atomically consumes records and filters expiry', async () => {
    let now = 1;
    const store = new MemoryAuthStore(() => now);
    await store.put('one', { ok: true }, 10);
    expect(await Promise.all([store.take('one'), store.take('one')])).toEqual([{ ok: true }, null]);
    await store.put('expired', {}, 2);
    now = 3;
    expect(await store.get('expired')).toBeNull();
    await store.put('pruned', {}, 2);
    await store.put('new', {}, 4);
    expect(await store.take('pruned')).toBeNull();
    await store.delete('new');
    expect(await store.get('new')).toBeNull();
  });
  it('rejects private, reserved and IPv6 destinations', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '::1',
      '2001:4860:4860::8888',
    ])
      expect(isPublicIpv4(address)).toBe(false);
    expect(isPublicIpv4('8.8.8.8')).toBe(true);
    for (const url of [
      'http://example.com/client.json',
      'https://example.com/',
      'https://example.com:444/client.json',
      'https://localhost/client.json',
      'https://host.local/client.json',
      'https://user:password@example.com/client.json',
      'https://example.com/client.json#part',
    ])
      expect(() => metadataUrl(url)).toThrow();
    expect(metadataUrl('https://example.com/client.json').hostname).toBe('example.com');
  });
  it('pins DNS and accepts bounded JSON without forwarding credentials', async () => {
    network.resolve4.mockResolvedValue(['8.8.8.8']);
    network.request.mockImplementation((_url, options, callback) => {
      const req = new EventEmitter() as EventEmitter & {
        end: () => void;
        destroy: (error: Error) => void;
      };
      const response = Object.assign(new EventEmitter(), {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        resume: vi.fn(),
      });
      expect(options.headers).toEqual({ accept: 'application/json' });
      const lookupResult = vi.fn();
      options.lookup('example.com', {}, lookupResult);
      expect(lookupResult).toHaveBeenCalledWith(null, '8.8.8.8', 4);
      req.destroy = (error) => {
        req.emit('error', error);
        req.emit('close');
      };
      req.end = () => {
        callback(response);
        response.emit('data', Buffer.from('{"client_name":"Test"}'));
        response.emit('end');
        req.emit('close');
      };
      return req;
    });
    expect(await fetchClientMetadata('https://example.com/client.json')).toEqual({
      client_name: 'Test',
    });
    network.resolve4.mockResolvedValue(['8.8.8.8', '127.0.0.1']);
    await expect(fetchClientMetadata('https://example.com/client.json')).rejects.toThrow(
      'not public',
    );
    network.resolve4.mockResolvedValue([]);
    await expect(fetchClientMetadata('https://example.com/client.json')).rejects.toThrow(
      'not public',
    );
  });
  it('rejects redirects, non-JSON, malformed JSON and oversized metadata', async () => {
    network.resolve4.mockResolvedValue(['8.8.8.8']);
    for (const scenario of [
      { status: 302, type: 'application/json', data: '{}' },
      { status: 200, type: 'text/html', data: '{}' },
      { status: 200, type: 'application/json', data: 'malformed' },
      { status: 200, type: 'application/json', data: 'a'.repeat(65537) },
    ]) {
      network.request.mockImplementation((_url, _options, callback) => {
        const req = new EventEmitter() as EventEmitter & {
          end: () => void;
          destroy: (error: Error) => void;
        };
        const response = Object.assign(new EventEmitter(), {
          statusCode: scenario.status,
          headers: { 'content-type': scenario.type },
          resume: vi.fn(),
        });
        req.destroy = (error) => {
          req.emit('error', error);
          req.emit('close');
        };
        req.end = () => {
          callback(response);
          response.emit('data', Buffer.from(scenario.data));
          response.emit('end');
          req.emit('close');
        };
        return req;
      });
      await expect(fetchClientMetadata('https://example.com/client.json')).rejects.toThrow();
    }
  });
});
