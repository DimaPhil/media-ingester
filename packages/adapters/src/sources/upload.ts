import type { ResolvedSource, Source } from '@media-ingest/contracts';
import type { AdapterContext } from '@media-ingest/sdk';
import { DownloadSource, type DownloadTarget } from './download.js';
import { copyToTarget } from './copy-to-target.js';

export class UploadSource extends DownloadSource {
  readonly kind = 'upload';

  protected async resolveSource(source: Source, context: AdapterContext) {
    const metadata = await this.options.files.uploadMetadata(context.ownerId, source.uri);
    return { source, fileName: metadata.fileName, metadata: {} };
  }

  protected async download(
    { source }: ResolvedSource,
    context: AdapterContext,
    target: DownloadTarget,
  ) {
    const metadata = await this.options.files.uploadMetadata(context.ownerId, source.uri);
    return copyToTarget(metadata.path, target);
  }
}
