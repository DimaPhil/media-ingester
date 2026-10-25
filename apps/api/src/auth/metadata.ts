import { resolve4 } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

export function isPublicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const octets = address.split('.').map(Number);
  const a = octets[0]!;
  const b = octets[1]!;
  const c = octets[2]!;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export function metadataUrl(clientId: string): URL {
  const url = new URL(clientId);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname === '/' ||
    (url.port && url.port !== '443') ||
    isIP(url.hostname) ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.local')
  ) {
    throw new Error('Client metadata must be an HTTPS URL with a path on a public host');
  }
  return url;
}

/** Public IPv4-only, DNS-pinned, no redirects, bounded response and timeout. */
export async function fetchClientMetadata(clientId: string): Promise<unknown> {
  const url = metadataUrl(clientId);
  const addresses = await resolve4(url.hostname);
  if (addresses.length === 0 || !addresses.every(isPublicIpv4)) {
    throw new Error('Client metadata host is not public');
  }
  const address = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        headers: { accept: 'application/json' },
        family: 4,
        lookup: (_hostname, _options, callback) => callback(null, address, 4),
      },
      (res) => {
        if (
          res.statusCode !== 200 ||
          !res.headers['content-type']?.toLowerCase().includes('application/json')
        ) {
          res.resume();
          reject(new Error('Client metadata must return JSON with status 200'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65536) {
            req.destroy(new Error('Client metadata exceeds 64 KiB'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('Invalid client metadata JSON'));
          }
        });
        res.on('error', reject);
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error('Client metadata request timed out')),
      5000,
    );
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
}
