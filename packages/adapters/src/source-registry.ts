import type { Source } from '@media-ingest/contracts';
import { MediaError } from '@media-ingest/sdk';
import { YouTubeSource } from './sources/youtube.js';
import { InstagramSource } from './sources/instagram.js';
import { XSource } from './sources/x.js';

/** Operator configuration, never accepted from an API request. */
export interface YtDlpSiteDefinition {
  id: string;
  hosts: readonly string[];
  extractors: readonly string[];
  /** Optional anchored URL pathname expression for custom single-item providers. */
  pathPattern?: string;
  validateUrl?(url: URL): void;
}
export interface YtDlpSiteAuth {
  cookiesPath?: string;
  cookiesFromBrowser?: string;
}
export const builtinYtDlpSites: readonly YtDlpSiteDefinition[] = [
  YouTubeSource.site,
  InstagramSource.site,
  XSource.site,
];
const reservedIds = new Set(['http', 'upload', 'local_file', 'google_drive', 'telegram', 'yt_dlp']);
export class YtDlpSourceRegistry {
  readonly sites: readonly YtDlpSiteDefinition[];
  constructor(custom: readonly YtDlpSiteDefinition[] = []) {
    const sites = [...builtinYtDlpSites, ...custom];
    const ids = new Set<string>();
    const hosts = new Set<string>();
    for (const site of sites) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(site.id) || ids.has(site.id) || reservedIds.has(site.id))
        throw new Error('Source registry IDs must be unique valid names');
      ids.add(site.id);
      if (!site.hosts.length || !site.extractors.length)
        throw new Error('Source registry entries need explicit hosts and extractors');
      for (const host of site.hosts) {
        if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host) || hosts.has(host))
          throw new Error('Source registry hosts must be unique exact lowercase DNS names');
        hosts.add(host);
      }
      for (const extractor of site.extractors) {
        if (
          !/^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/.test(extractor) ||
          ['all', 'default', 'end', 'generic'].includes(extractor.toLowerCase())
        )
          throw new Error(
            'Source registry requires explicit extractor names, not wildcards or generic fallbacks',
          );
      }
      if (site.pathPattern) {
        if (!site.pathPattern.startsWith('^') || !site.pathPattern.endsWith('$'))
          throw new Error('Source registry path patterns must be anchored');
        new RegExp(site.pathPattern);
      }
    }
    this.sites = sites.map((site) => ({
      ...site,
      hosts: [...site.hosts],
      extractors: [...site.extractors],
    }));
  }
  select(source: Source): { site: YtDlpSiteDefinition; url: URL } {
    let url: URL;
    try {
      url = new URL(source.uri);
    } catch {
      throw new MediaError('invalid_input', 'Source URL must be absolute');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.port && !['80', '443'].includes(url.port))
    )
      throw new MediaError(
        'invalid_input',
        'Social sources require an HTTP(S) URL without credentials or custom ports',
      );
    const site = this.sites.find((candidate) => candidate.hosts.includes(url.hostname));
    if (!site) {
      const threads = ['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net'].includes(
        url.hostname,
      );
      throw new MediaError(
        'unsupported_source',
        threads
          ? 'Threads is not supported by the bundled download providers; configure a reviewed provider explicitly'
          : 'Source host is not allowed; register an explicit host and extractor policy',
      );
    }
    if (source.kind !== 'yt_dlp' && source.kind !== site.id)
      throw new MediaError(
        'invalid_input',
        `URL does not belong to the ${source.kind} source provider`,
      );
    site.validateUrl?.(url);
    if (site.pathPattern && !new RegExp(site.pathPattern).test(url.pathname)) {
      throw new MediaError('invalid_input', `Expected a single ${site.id} post URL`);
    }
    url.hash = '';
    return { site, url };
  }
  extractorArgument(site: YtDlpSiteDefinition): string {
    return site.extractors.map((name) => `^${name}$`).join(',');
  }
}
