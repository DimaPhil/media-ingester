import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { MediaError } from '@media-ingest/sdk';

const reservedV6 = new BlockList();
reservedV6.addSubnet('2001::', 23, 'ipv6');
reservedV6.addSubnet('2001:db8::', 32, 'ipv6');
reservedV6.addSubnet('2002::', 16, 'ipv6');
reservedV6.addSubnet('3fff::', 20, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(normalized) === 6) {
    // Accept only currently assigned global unicast. This excludes mapped IPv4,
    // link-local, unique-local, multicast, loopback and translation mechanisms.
    return /^[23]/.test(normalized) && !reservedV6.check(normalized, 'ipv6');
  }
  if (isIP(normalized) !== 4) return false;
  const [a = 0, b = 0] = normalized.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 168].includes(b)) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0)
  );
}
export async function publicUrl(
  uri: string,
): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new MediaError('invalid_input', 'Source URL must be absolute');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new MediaError('invalid_input', 'Source requires an HTTP(S) URL without credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address)))
    throw new MediaError(
      'invalid_input',
      'Private and reserved network destinations are forbidden',
    );
  return { url, ...addresses[0]! };
}
export async function safeRequest(
  uri: string,
  options: { signal: AbortSignal; method?: 'GET' | 'HEAD'; maxRedirects?: number },
): Promise<IncomingMessage> {
  let current = uri;
  for (let redirects = 0; redirects <= (options.maxRedirects ?? 5); redirects++) {
    options.signal.throwIfAborted();
    const { url, address, family } = await publicUrl(current);
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method: options.method ?? 'GET',
          signal: options.signal,
          family,
          lookup: (_hostname, _options, callback) => callback(null, address, family),
          headers: { 'user-agent': 'media-ingest/1' },
        },
        resolve,
      );
      request.on('error', reject);
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
      response.resume();
      current = new URL(response.headers.location, url).href;
      continue;
    }
    if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
      response.resume();
      throw new Error(`Source HTTP status ${response.statusCode}`);
    }
    return response;
  }
  throw new Error('Too many source redirects');
}
export async function saveStream(
  stream: NodeJS.ReadableStream,
  destination: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<void> {
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > maxBytes ? new Error('Media exceeds configured download limit') : null,
        chunk,
      );
    },
  });
  await pipeline(stream, limit, createWriteStream(destination, { mode: 0o600 }), { signal });
}
