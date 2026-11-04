import { createHash } from 'node:crypto';
import type { Grant } from './consent.js';
import { equal, error, formParameters, hash, HOUR, json, random, SCOPES } from './protocol.js';
import type { AuthStore } from './store.js';

export interface Identity {
  ownerId: 'owner';
  scopes: string[];
}
interface Token {
  resource: string;
  scopes: string[];
  expiresAt: number;
}

export function createTokens(
  store: AuthStore,
  now: () => number,
  ownerToken: string,
  resource: string,
) {
  async function authenticate(request: Request, target = resource): Promise<Identity | null> {
    const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '');
    if (!match || match[1]!.length > 4096) return null;
    if (equal(match[1]!, ownerToken)) return { ownerId: 'owner', scopes: [...SCOPES] };
    const saved = (await store.get(`token:${hash(match[1]!)}`)) as Token | null;
    if (!saved || saved.expiresAt <= now() || saved.resource !== target) return null;
    return { ownerId: 'owner', scopes: saved.scopes };
  }

  async function exchange(request: Request) {
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

  async function revoke(request: Request) {
    const params = await formParameters(request);
    await store.delete(`token:${hash(params.get('token') ?? '')}`);
    return json({});
  }
  return { authenticate, exchange, revoke };
}
