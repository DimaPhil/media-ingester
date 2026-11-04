import { safeName } from '../files.js';
import { safeRequest, saveStream } from '../safe-fetch.js';
import type { ResolvedSource, Source } from '@media-ingest/contracts';
import type { AdapterContext } from '@media-ingest/sdk';
import { DownloadSource, type DownloadTarget } from './download.js';

export class HttpSource extends DownloadSource {
  readonly kind = 'http';
  protected async resolveSource(source: Source, { signal }: AdapterContext) {
    const response = await safeRequest(source.uri, { signal, method: 'HEAD' });
    response.resume();
    const mimeType = response.headers['content-type'];
    return {
      source,
      fileName: safeName(new URL(source.uri).pathname),
      ...(mimeType ? { mimeType } : {}),
      metadata: {},
    };
  }
  protected async download(
    { source }: ResolvedSource,
    { signal }: AdapterContext,
    { path, maxBytes }: DownloadTarget,
  ) {
    await saveStream(await safeRequest(source.uri, { signal }), path, maxBytes, signal);
    return path;
  }
}
