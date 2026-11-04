import { stat } from 'node:fs/promises';
import type { ResolvedSource, Source } from '@media-ingest/contracts';
import type { AdapterContext } from '@media-ingest/sdk';
import { safeName } from '../files.js';
import { DownloadSource, type DownloadTarget } from './download.js';
import { copyToTarget } from './copy-to-target.js';

export class LocalFileSource extends DownloadSource {
  readonly kind = 'local_file';

  protected async resolveSource(source: Source) {
    const info = await stat(source.uri);
    if (!info.isFile()) throw new Error('Local source must be a regular file');
    return { source, fileName: safeName(source.uri), metadata: { size: info.size } };
  }

  protected download({ source }: ResolvedSource, _context: AdapterContext, target: DownloadTarget) {
    return copyToTarget(source.uri, target);
  }
}
