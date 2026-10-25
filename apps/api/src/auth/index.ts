import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fetchClientMetadata as defaultFetchClientMetadata, metadataUrl } from './metadata.js';
import type { AuthStore } from './store.js';

export { MemoryAuthStore } from './store.js';
export type { AuthStore } from './store.js';

const SCOPES = ['media:read', 'media:write'];
const TEN_MINUTES = 10 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MAX_BODY = 65536;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const equal = (left: string, right: string) =>
  timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)));
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface Identity {
  ownerId: 'owner';
  scopes: string[];
}
export interface AuthOptions {
  publicUrl: string;
  ownerToken: string;
  store: AuthStore;
  now?: () => number;
  /** Testing hook or another equally strict SSRF-safe fetch implementation. */
  fetchClientMetadata?: (clientId: string) => Promise<unknown>;
}
interface Client {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  application_type: 'web' | 'native';
}
interface Grant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  scopes: string[];
  state: string;
}
interface Consent {
  grant: Grant;
  clientName: string;
  browserSecret: string;
}
interface Token {
  resource: string;
  scopes: string[];
  expiresAt: number;
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...headers },
  });
}
function error(name: string, description: string, status = 400): Response {
  return json({ error: name, error_description: description }, status);
}
function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}
function cookie(request: Request, name: string): string | undefined {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
async function body(request: Request): Promise<string> {
  if (Number(request.headers.get('content-length')) > MAX_BODY)
    throw new Error('Request body exceeds 64 KiB');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > MAX_BODY) {
        await reader.cancel();
        throw new Error('Request body exceeds 64 KiB');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function formParameters(request: Request): Promise<URLSearchParams> {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))
    throw new Error('Expected form data');
  const params = new URLSearchParams(await body(request));
  if ([...new Set(params.keys())].some((key) => params.getAll(key).length !== 1))
    throw new Error('Duplicate form parameters');
  return params;
}
function validateClient(value: unknown, id: string): Client {
  if (
    !record(value) ||
    typeof value.client_name !== 'string' ||
    !value.client_name.trim() ||
    value.client_name.length > 200 ||
    !Array.isArray(value.redirect_uris) ||
    value.redirect_uris.length < 1 ||
    value.redirect_uris.length > 10 ||
    (value.token_endpoint_auth_method !== undefined &&
      value.token_endpoint_auth_method !== 'none') ||
    (value.application_type !== undefined &&
      value.application_type !== 'web' &&
      value.application_type !== 'native') ||
    (value.grant_types !== undefined &&
      (!Array.isArray(value.grant_types) ||
        value.grant_types.length !== 1 ||
        value.grant_types[0] !== 'authorization_code')) ||
    (value.response_types !== undefined &&
      (!Array.isArray(value.response_types) ||
        value.response_types.length !== 1 ||
        value.response_types[0] !== 'code'))
  ) {
    throw new Error('Invalid public client metadata');
  }
  const application = value.application_type === 'native' ? 'native' : 'web';
  const redirects = value.redirect_uris.map((uri: unknown) => {
    if (typeof uri !== 'string' || uri.length > 4096) throw new Error('Invalid redirect URI');
    const url = new URL(uri);
    const loopback =
      application === 'native' &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!loopback && url.protocol !== 'https:') || url.hash || url.username || url.password)
      throw new Error('Redirects require HTTPS, or native HTTP loopback');
    return uri;
  });
  return {
    client_id: id,
    client_name: value.client_name,
    redirect_uris: redirects,
    application_type: application,
  };
}

export function createAuth(options: AuthOptions) {
  const issuer = options.publicUrl.replace(/\/$/, '');
  const publicUrl = new URL(issuer);
  if (
    publicUrl.origin !== issuer ||
    publicUrl.username ||
    publicUrl.password ||
    (publicUrl.protocol !== 'https:' &&
      !(
        publicUrl.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)
      ))
  ) {
    throw new Error('publicUrl must be an HTTPS origin (HTTP loopback allowed for development)');
  }
  if (options.ownerToken.length < 32)
    throw new Error('Owner token must contain at least 32 characters');
  const resource = `${issuer}/mcp`;
  const now = options.now ?? Date.now;
  const store = options.store;
  const fetchMetadata = options.fetchClientMetadata ?? defaultFetchClientMetadata;
  const secureCookie = publicUrl.protocol === 'https:' ? '; Secure' : '';
  const cookieName = publicUrl.protocol === 'https:' ? '__Host-media-consent' : 'media-consent';
  let windowStart = now();
  let publicRequests = 0;

  async function client(clientId: string): Promise<Client> {
    if (clientId.length > 4096) throw new Error('Client ID too long');
    if (clientId.startsWith('https://')) {
      metadataUrl(clientId);
      const metadata = await fetchMetadata(clientId);
      if (!record(metadata) || metadata.client_id !== clientId)
        throw new Error('Client metadata client_id mismatch');
      return validateClient(metadata, clientId);
    }
    const saved = await store.get(`client:${hash(clientId)}`);
    if (!saved) throw new Error('Unknown or expired client');
    return validateClient(saved, clientId);
  }

  function challenge(target = resource): Response {
    const metadata =
      target === resource
        ? `${issuer}/.well-known/oauth-protected-resource/mcp`
        : `${issuer}/.well-known/oauth-protected-resource`;
    return json({ error: 'unauthorized' }, 401, {
      'www-authenticate': `Bearer resource_metadata="${metadata}", scope="media:read media:write"`,
    });
  }

  async function authenticate(request: Request, target = resource): Promise<Identity | null> {
    const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '');
    if (!match || match[1]!.length > 4096) return null;
    if (equal(match[1]!, options.ownerToken)) return { ownerId: 'owner', scopes: [...SCOPES] };
    const saved = (await store.get(`token:${hash(match[1]!)}`)) as Token | null;
    if (!saved || saved.expiresAt <= now() || saved.resource !== target) return null;
    return { ownerId: 'owner', scopes: saved.scopes };
  }

  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (
      ![
        '/.well-known/oauth-authorization-server',
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/mcp',
        '/oauth/register',
        '/oauth/authorize',
        '/oauth/token',
        '/oauth/revoke',
      ].includes(path)
    )
      return null;
    try {
      if (request.method === 'OPTIONS' && path !== '/oauth/authorize') {
        return new Response(null, {
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '600',
          },
        });
      }
      if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
        return json({
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          registration_endpoint: `${issuer}/oauth/register`,
          revocation_endpoint: `${issuer}/oauth/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: SCOPES,
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (request.method === 'GET' && path.startsWith('/.well-known/oauth-protected-resource')) {
        return json({
          resource: path.endsWith('/mcp') ? resource : issuer,
          authorization_servers: [issuer],
          scopes_supported: SCOPES,
          bearer_methods_supported: ['header'],
        });
      }
      // Bound unauthenticated registration/approval work per process; edge ingress should also rate-limit.
      if (now() - windowStart >= 60000) {
        windowStart = now();
        publicRequests = 0;
      }
      if (++publicRequests > 60)
        return error('temporarily_unavailable', 'Too many authorization requests', 429);

      if (path === '/oauth/register' && request.method === 'POST') {
        if (!request.headers.get('content-type')?.startsWith('application/json'))
          return error('invalid_client_metadata', 'Expected application/json');
        const registered = validateClient(JSON.parse(await body(request)), `media_${random()}`);
        await store.put(`client:${hash(registered.client_id)}`, registered, now() + 30 * 24 * HOUR);
        return json(
          {
            ...registered,
            client_id_issued_at: Math.floor(now() / 1000),
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code'],
            response_types: ['code'],
          },
          201,
        );
      }
      if (path === '/oauth/authorize' && request.method === 'GET') {
        const params = url.searchParams;
        if ([...new Set(params.keys())].some((key) => params.getAll(key).length !== 1))
          throw new Error('Duplicate authorization parameters');
        const registered = await client(params.get('client_id') ?? '');
        const redirectUri = params.get('redirect_uri') ?? '';
        const scopes = (params.get('scope') ?? '').split(' ').filter(Boolean);
        const challengeValue = params.get('code_challenge') ?? '';
        if (!registered.redirect_uris.includes(redirectUri))
          throw new Error('Unregistered redirect URI');
        if (
          params.get('response_type') !== 'code' ||
          params.get('code_challenge_method') !== 'S256' ||
          !/^[A-Za-z0-9_-]{43}$/.test(challengeValue)
        )
          throw new Error('Authorization code with S256 PKCE is required');
        if (params.get('resource') !== resource && params.get('resource') !== issuer)
          throw new Error('Invalid resource');
        if (scopes.length === 0 || scopes.some((scope) => !SCOPES.includes(scope)))
          return error('invalid_scope', 'Request media:read and/or media:write');
        const state = params.get('state') ?? '';
        if (state.length > 4096) throw new Error('State too long');
        const consentId = random();
        const browserSecret = random();
        const grant: Grant = {
          clientId: registered.client_id,
          redirectUri,
          challenge: challengeValue,
          resource: params.get('resource')!,
          scopes: [...new Set(scopes)],
          state,
        };
        await store.put(
          `consent:${hash(consentId)}`,
          { grant, clientName: registered.client_name, browserSecret } satisfies Consent,
          now() + TEN_MINUTES,
        );
        const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Media Ingest</title><body><main><h1>Authorize ${escape(registered.client_name)}</h1><p>This client requests access to your private media service.</p><p>Client: <code>${escape(registered.client_id)}</code></p><p>Permissions: ${escape(scopes.join(', '))}</p><p>Redirect: <code>${escape(redirectUri)}</code></p><form method="post" action="/oauth/authorize"><input type="hidden" name="consent" value="${consentId}"><label>Owner API token <input type="password" name="owner_token" required autocomplete="off"></label><button type="submit" name="decision" value="approve">Approve access</button><button type="submit" name="decision" value="deny" formnovalidate>Deny</button></form></main></body></html>`;
        return new Response(html, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-security-policy':
              "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            'x-frame-options': 'DENY',
            'referrer-policy': 'no-referrer',
            'set-cookie': `${cookieName}=${browserSecret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secureCookie}`,
          },
        });
      }
      if (path === '/oauth/authorize' && request.method === 'POST') {
        if (request.headers.get('origin') !== issuer)
          return error('invalid_request', 'Invalid approval origin', 403);
        const params = await formParameters(request);
        const key = `consent:${hash(params.get('consent') ?? '')}`;
        const consent = (await store.get(key)) as Consent | null;
        const browserSecret = cookie(request, cookieName);
        if (!consent || !browserSecret || !equal(browserSecret, consent.browserSecret))
          return error('invalid_request', 'Expired or invalid approval session', 403);
        const decision = params.get('decision');
        if (
          decision !== 'deny' &&
          (decision !== 'approve' || !equal(params.get('owner_token') ?? '', options.ownerToken))
        )
          return error('access_denied', 'Owner authentication required', 403);
        if (!(await store.take(key))) return error('invalid_request', 'Approval already used', 403);
        const redirect = new URL(consent.grant.redirectUri);
        redirect.searchParams.set('iss', issuer);
        if (consent.grant.state) redirect.searchParams.set('state', consent.grant.state);
        if (decision === 'deny') redirect.searchParams.set('error', 'access_denied');
        else {
          const code = random();
          await store.put(`code:${hash(code)}`, consent.grant, now() + 60000);
          redirect.searchParams.set('code', code);
        }
        return new Response(null, {
          status: 303,
          headers: {
            location: redirect.toString(),
            'cache-control': 'no-store',
            'set-cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie}`,
          },
        });
      }
      if (path === '/oauth/token' && request.method === 'POST') {
        const params = await formParameters(request);
        if (params.get('grant_type') !== 'authorization_code')
          return error('unsupported_grant_type', 'Only authorization_code is supported');
        const code = params.get('code') ?? '';
        const grant = (await store.take(`code:${hash(code)}`)) as Grant | null;
        const verifier = params.get('code_verifier') ?? '';
        const challengeValue = createHash('sha256').update(verifier).digest('base64url');
        if (
          !grant ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
          !equal(grant.challenge, challengeValue) ||
          params.get('client_id') !== grant.clientId ||
          params.get('redirect_uri') !== grant.redirectUri ||
          params.get('resource') !== grant.resource
        )
          return error('invalid_grant', 'Invalid or expired authorization code');
        const token = random();
        await store.put(
          `token:${hash(token)}`,
          {
            resource: grant.resource,
            scopes: grant.scopes,
            expiresAt: now() + HOUR,
          } satisfies Token,
          now() + HOUR,
        );
        return json({
          access_token: token,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: grant.scopes.join(' '),
        });
      }
      if (path === '/oauth/revoke' && request.method === 'POST') {
        const params = await formParameters(request);
        await store.delete(`token:${hash(params.get('token') ?? '')}`);
        return json({});
      }
      return error('invalid_request', 'Method not allowed', 405);
    } catch {
      // Never reflect database, DNS or parser diagnostics into a public response.
      return error('invalid_request', 'Invalid authorization request');
    }
  }
  return { handle, authenticate, challenge };
}
