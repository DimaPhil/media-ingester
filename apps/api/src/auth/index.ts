import { createClients } from './clients.js';
import { createConsent } from './consent.js';
import { error, json, SCOPES } from './protocol.js';
import { createTokens } from './tokens.js';
import type { AuthStore } from './store.js';

export { MemoryAuthStore } from './store.js';
export type { AuthStore } from './store.js';

export type { Identity } from './tokens.js';

export interface AuthOptions {
  publicUrl: string;
  ownerToken: string;
  store: AuthStore;
  now?: () => number;
  /** Testing hook or another equally strict SSRF-safe fetch implementation. */
  fetchClientMetadata?: (clientId: string) => Promise<unknown>;
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
  const tokens = createTokens(store, now, options.ownerToken, resource);
  const clients = createClients(store, now, options.fetchClientMetadata);
  const consent = createConsent({
    issuer,
    store,
    now,
    ownerToken: options.ownerToken,
    resolveClient: clients.resolve,
  });
  let windowStart = now();
  let publicRequests = 0;

  function challenge(target = resource): Response {
    const metadata =
      target === resource
        ? `${issuer}/.well-known/oauth-protected-resource/mcp`
        : `${issuer}/.well-known/oauth-protected-resource`;
    return json({ error: 'unauthorized' }, 401, {
      'www-authenticate': `Bearer resource_metadata="${metadata}", scope="media:read media:write"`,
    });
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

      if (path === '/oauth/register' && request.method === 'POST')
        return await clients.register(request);
      if (path === '/oauth/authorize' && request.method === 'GET')
        return await consent.begin(url.searchParams);
      if (path === '/oauth/authorize' && request.method === 'POST')
        return await consent.decide(request);
      if (path === '/oauth/token' && request.method === 'POST')
        return await tokens.exchange(request);
      if (path === '/oauth/revoke' && request.method === 'POST')
        return await tokens.revoke(request);
      return error('invalid_request', 'Method not allowed', 405);
    } catch {
      // Never reflect database, DNS or parser diagnostics into a public response.
      return error('invalid_request', 'Invalid authorization request');
    }
  }
  return { handle, authenticate: tokens.authenticate, challenge };
}
