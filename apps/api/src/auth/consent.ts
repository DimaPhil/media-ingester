import type { Client } from './clients.js';
import {
  equal,
  error,
  formParameters,
  hash,
  random,
  requireUniqueParameters,
  SCOPES,
} from './protocol.js';
import type { AuthStore } from './store.js';

const TEN_MINUTES = 10 * 60 * 1000;
export interface Grant {
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

export function createConsent(options: {
  issuer: string;
  ownerToken: string;
  store: AuthStore;
  now: () => number;
  resolveClient: (clientId: string) => Promise<Client>;
}) {
  const { issuer, store, now, resolveClient } = options;
  const secure = new URL(issuer).protocol === 'https:';
  const secureCookie = secure ? '; Secure' : '';
  const cookieName = secure ? '__Host-media-consent' : 'media-consent';
  async function begin(params: URLSearchParams) {
    requireUniqueParameters(params);
    const registered = await resolveClient(params.get('client_id') ?? '');
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
    if (params.get('resource') !== `${issuer}/mcp` && params.get('resource') !== issuer)
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

  async function decide(request: Request) {
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
  return { begin, decide };
}
