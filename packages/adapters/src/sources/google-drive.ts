import { MediaError, type AdapterContext } from '@media-ingest/sdk';
import type { Source, ResolvedSource } from '@media-ingest/contracts';
import { safeName } from '../files.js';
import { googleAccessToken } from '../google-auth.js';
import { sourceUrl, checkedFetch, saveResponse } from './service-http.js';
import { DownloadSource, type DownloadOptions, type DownloadTarget } from './download.js';

export function driveId(uri: string): string {
  const url = sourceUrl(uri);
  if (
    url.protocol !== 'https:' ||
    !['drive.google.com', 'docs.google.com'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new MediaError('invalid_input', 'Invalid Google Drive URL');
  const id = url.searchParams.get('id') ?? url.pathname.match(/\/d\/([^/]+)/)?.[1];
  if (!id || !/^[\w-]+$/.test(id) || url.pathname.includes('/folders/'))
    throw new MediaError('invalid_input', 'Expected a single Google Drive file');
  return id;
}

export class GoogleDriveSource extends DownloadSource {
  readonly kind = 'google_drive';
  constructor(
    options: DownloadOptions,
    private readonly credentials?: Record<string, unknown>,
  ) {
    super(options);
  }
  protected async resolveSource(source: Source, { signal }: AdapterContext) {
    const id = driveId(source.uri);
    const token = await googleAccessToken(this.credentials);
    const response = await checkedFetch(
      `https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType,size&supportsAllDrives=true`,
      { signal, headers: { Authorization: `Bearer ${token}` } },
    );
    const data = (await response.json()) as { name?: string; mimeType?: string };
    if (!data.name) throw new Error('Drive file name is missing');
    return {
      source,
      fileName: safeName(data.name),
      ...(data.mimeType ? { mimeType: data.mimeType } : {}),
      metadata: { id, mediaId: id },
    };
  }
  protected async download(
    { source }: ResolvedSource,
    { signal }: AdapterContext,
    target: DownloadTarget,
  ) {
    const token = await googleAccessToken(this.credentials);
    const response = await checkedFetch(
      `https://www.googleapis.com/drive/v3/files/${driveId(source.uri)}?alt=media&supportsAllDrives=true`,
      { signal, headers: { Authorization: `Bearer ${token}` } },
    );
    return saveResponse(response, target, signal);
  }
}
