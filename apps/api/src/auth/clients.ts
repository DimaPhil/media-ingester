import { fetchClientMetadata, metadataUrl } from './metadata.js';
import { body, error, hash, HOUR, json, random } from './protocol.js';
import type { AuthStore } from './store.js';

export interface Client {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  application_type: 'web' | 'native';
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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

export function createClients(
  store: AuthStore,
  now: () => number,
  fetchMetadata: (id: string) => Promise<unknown> = fetchClientMetadata,
) {
  async function resolve(clientId: string): Promise<Client> {
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

  async function register(request: Request) {
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

  return { resolve, register };
}
