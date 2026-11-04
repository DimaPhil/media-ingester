import { MediaError } from '@media-ingest/sdk';
import type { YtDlpSiteDefinition } from '../source-registry.js';
import { YtDlpSourceBase } from './yt-dlp-base.js';

export class YouTubeSource extends YtDlpSourceBase {
  readonly kind = 'youtube';
  static readonly site: YtDlpSiteDefinition = {
    id: 'youtube',
    hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
    extractors: ['youtube'],
    validateUrl(url) {
      const id =
        url.hostname === 'youtu.be'
          ? url.pathname.slice(1).replace(/\/$/, '')
          : url.pathname === '/watch'
            ? url.searchParams.get('v')
            : url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]+)\/?$/)?.[1];
      if (url.searchParams.has('list') || !id || !/^[A-Za-z0-9_-]+$/.test(id))
        throw new MediaError(
          'invalid_input',
          'Expected one YouTube video, not a playlist, channel or search URL',
        );
    },
  };
}
