import type { Source } from '@media-ingest/contracts';
import { MediaError } from '@media-ingest/sdk';
import { YtDlpSourceBase } from './yt-dlp-base.js';

/** Selects a registered extractor by URL, including operator-configured sites. */
export class YtDlpSource extends YtDlpSourceBase {
  readonly kind = 'yt_dlp';
  protected override selectSite(source: Source) {
    const selection = super.selectSite(source);
    const hosts = this.options.ytDlpAllowedHosts;
    if (hosts && !hosts.includes(selection.url.hostname)) {
      throw new MediaError('unsupported_source', 'Source host is not in the configured allowlist');
    }
    return selection;
  }
}
