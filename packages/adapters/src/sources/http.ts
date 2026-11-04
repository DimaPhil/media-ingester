import { safeName } from '../files.js';
import { safeRequest, saveStream } from '../safe-fetch.js';
import type { SourceDriver } from './download.js';

export const httpSource: SourceDriver = {
  async resolve(source, { signal }) {
    const response = await safeRequest(source.uri, { signal, method: 'HEAD' });
    response.resume();
    const mimeType = response.headers['content-type'];
    return {
      source,
      fileName: safeName(new URL(source.uri).pathname),
      ...(mimeType ? { mimeType } : {}),
      metadata: {},
    };
  },
  async download({ source }, { signal }, { path, maxBytes }) {
    await saveStream(await safeRequest(source.uri, { signal }), path, maxBytes, signal);
    return path;
  },
};
