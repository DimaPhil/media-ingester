import { createHash } from 'node:crypto';
import {
  contractDocument,
  operations,
  type Input,
  type OperationId,
  type Output,
} from '@media-ingest/contracts';

export class MediaClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'MediaClientError';
  }
}

export function validateBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw new MediaClientError('API URL must not contain credentials, a query, or a fragment');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new MediaClientError('Use HTTPS for a remote API; HTTP is allowed only on loopback');
  return url.href.replace(/\/$/, '');
}

export interface MediaClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** HTTP only. This package deliberately has no dependency on the execution SDK. */
export class MediaClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  readonly contractHash = createHash('sha256')
    .update(JSON.stringify(contractDocument()))
    .digest('hex');

  constructor(options: MediaClientOptions) {
    this.baseUrl = validateBaseUrl(options.baseUrl);
    if (!options.token.trim() || /[\r\n]/u.test(options.token))
      throw new MediaClientError('A nonempty API token is required');
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async call<K extends OperationId>(id: K, input: Input<K>): Promise<Output<K>> {
    const operation = operations[id];
    const parsed = operation.input.safeParse(input);
    if (!parsed.success)
      throw new MediaClientError(
        `Invalid ${id} input: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        undefined,
        'invalid_input',
      );
    // Check each mutation, not once per process: a rolling deployment can change the server.
    if (operation.method !== 'GET') {
      const info = await this.request('info', {});
      if (info.contractHash !== this.contractHash)
        throw new MediaClientError(
          'API contract differs from this CLI/client. Install the CLI release matching the server before writing.',
          undefined,
          'contract_mismatch',
        );
    }
    return this.request(id, parsed.data as Input<K>);
  }

  private async request<K extends OperationId>(id: K, input: Input<K>): Promise<Output<K>> {
    const operation = operations[id];
    const data = input as Record<string, unknown>;
    const pathNames = new Set<string>();
    const path = operation.path.replace(/:([A-Za-z]+)/gu, (_, name: string) => {
      pathNames.add(name);
      return encodeURIComponent(String(data[name]));
    });
    const url = new URL(this.baseUrl + path);
    if (operation.method === 'GET')
      for (const [key, value] of Object.entries(data))
        if (!pathNames.has(key) && value !== undefined) url.searchParams.set(key, String(value));
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: operation.method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          'content-type': 'application/json',
          'x-media-contract': this.contractHash,
        },
        ...(operation.method !== 'GET' ? { body: JSON.stringify(input) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new MediaClientError(
        'API request failed. Check the API URL, network, and server availability.',
        undefined,
        'network_error',
      );
    }
    if (!response.ok) {
      // Never reflect arbitrary server response bodies: they may contain credentials or upstream payloads.
      const hint =
        response.status === 401
          ? 'Authentication failed; check MEDIA_API_TOKEN.'
          : response.status === 403
            ? 'Access denied.'
            : response.status === 404
              ? 'Resource not found.'
              : response.status === 409
                ? 'Conflict; inspect the job or idempotency key.'
                : `API returned HTTP ${response.status}.`;
      throw new MediaClientError(hint, response.status, 'http_error');
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new MediaClientError('API returned invalid JSON', response.status, 'invalid_response');
    }
    const parsed = operation.output.safeParse(value);
    if (!parsed.success)
      throw new MediaClientError(
        `API response does not match the ${id} contract`,
        response.status,
        'invalid_response',
      );
    return parsed.data as Output<K>;
  }
}
