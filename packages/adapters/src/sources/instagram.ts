import type { YtDlpSiteDefinition } from '../source-registry.js';
import { YtDlpSourceBase } from './yt-dlp-base.js';

export class InstagramSource extends YtDlpSourceBase {
  readonly kind = 'instagram';
  static readonly site: YtDlpSiteDefinition = {
    id: 'instagram',
    hosts: ['instagram.com', 'www.instagram.com'],
    extractors: ['Instagram'],
    pathPattern: '^/(?:p|reel|reels|tv)/[A-Za-z0-9_-]+/?$',
  };
}
