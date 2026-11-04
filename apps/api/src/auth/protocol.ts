import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SCOPES = ['media:read', 'media:write'];
export const HOUR = 60 * 60 * 1000;
const MAX_BODY = 65536;
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const random = () => randomBytes(32).toString('base64url');
export const equal = (left: string, right: string) =>
  timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)));

export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...headers },
  });
}
export function error(name: string, description: string, status = 400): Response {
  return json({ error: name, error_description: description }, status);
}
export async function body(request: Request): Promise<string> {
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
export function requireUniqueParameters(params: URLSearchParams): void {
  if ([...new Set(params.keys())].some((key) => params.getAll(key).length !== 1))
    throw new Error('Duplicate OAuth parameters');
}
export async function formParameters(request: Request): Promise<URLSearchParams> {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))
    throw new Error('Expected form data');
  const params = new URLSearchParams(await body(request));
  requireUniqueParameters(params);
  return params;
}
