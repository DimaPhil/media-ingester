import { Readable } from 'node:stream';
import { MediaError } from '@media-ingest/sdk';
import { saveStream } from '../safe-fetch.js';
import type { DownloadTarget } from './download.js';

export function sourceUrl(uri: string): URL {
  try {
    return new URL(uri);
  } catch {
    throw new MediaError('invalid_input', 'Source URL must be absolute');
  }
}

export async function checkedFetch(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'error' });
  if (!response.ok) throw new Error(`Source service returned HTTP ${response.status}`);
  return response;
}

export async function saveResponse(
  response: Response,
  { path, maxBytes }: DownloadTarget,
  signal: AbortSignal,
) {
  if (!response.body) throw new Error('Source service returned an empty body');
  const reader = response.body.getReader();
  async function* chunks() {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        yield next.value;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  await saveStream(Readable.from(chunks()), path, maxBytes, signal);
  return path;
}
