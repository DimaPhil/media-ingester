import type { ResolvedSource, Source } from '@media-ingest/contracts';
import type { AdapterContext } from '@media-ingest/sdk';
import { DownloadSource, type DownloadTarget } from './download.js';
import { copyToTarget } from './copy-to-target.js';

export class UploadSource extends DownloadSource {
  readonly kind = 'upload';

  protected async resolveSource(source: Source, context: AdapterContext) {
    return this.options.files.withUpload(context.ownerId, source.uri, ({ fileName }) => ({
      source,
      fileName,
      metadata: { mediaId: source.uri },
    }));
  }

  protected async download(
    { source }: ResolvedSource,
    context: AdapterContext,
    target: DownloadTarget,
  ) {
    return this.options.files.withUpload(context.ownerId, source.uri, ({ path }) =>
      copyToTarget(path, target),
    );
  }
}
