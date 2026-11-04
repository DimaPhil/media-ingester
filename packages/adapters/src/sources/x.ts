import type { YtDlpSiteDefinition } from '../source-registry.js';
import { YtDlpSourceBase } from './yt-dlp-base.js';

export class XSource extends YtDlpSourceBase {
  readonly kind = 'x';
  static readonly site: YtDlpSiteDefinition = {
    id: 'x',
    hosts: [
      'x.com',
      'www.x.com',
      'mobile.x.com',
      'twitter.com',
      'www.twitter.com',
      'mobile.twitter.com',
    ],
    extractors: ['twitter'],
    pathPattern: '^/(?:[A-Za-z0-9_]+/status|i/status)/[0-9]+(?:/video/[0-9]+)?/?$',
  };
}
