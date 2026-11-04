import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Source, ResolvedSource } from '@media-ingest/contracts';
import { type AdapterContext, MediaError } from '@media-ingest/sdk';
import { publicUrl } from '../safe-fetch.js';
import { runCommand } from '../run-command.js';
import { safeName } from '../files.js';
import {
  YtDlpSourceRegistry,
  type YtDlpSiteAuth,
  type YtDlpSiteDefinition,
} from '../source-registry.js';
import type { DownloadTarget, SourceDriver } from './download.js';

export interface YtDlpOptions {
  timeoutMs?: number;
  ytDlpPath?: string;
  ytDlpAllowedHosts?: string[];
  ytDlpSites?: YtDlpSiteDefinition[];
  ytDlpAuth?: Record<string, YtDlpSiteAuth>;
  ytDlpCookiesPath?: string;
  ytDlpCookiesFromBrowser?: string;
}
export class YtDlpSource implements SourceDriver {
  private readonly registry: YtDlpSourceRegistry;
  constructor(private readonly options: YtDlpOptions) {
    this.registry = new YtDlpSourceRegistry(options.ytDlpSites);
  }
  private async socialSource(
    source: Source,
  ): Promise<{ uri: string; args: string[]; siteId: string }> {
    const { site, url } = this.registry.select(source);
    if (
      source.kind === 'yt_dlp' &&
      this.options.ytDlpAllowedHosts &&
      !this.options.ytDlpAllowedHosts.includes(url.hostname)
    )
      throw new MediaError('unsupported_source', 'Source host is not in the configured allowlist');
    await publicUrl(url.href);
    return {
      uri: url.href,
      siteId: site.id,
      args: [
        '--use-extractors',
        this.registry.extractorArgument(site),
        '--js-runtimes',
        'node',
        ...this.cookieArgs(site.id),
      ],
    };
  }
  private cookieArgs(siteId: string): string[] {
    // Legacy cookies configured before named providers remain scoped to YouTube.
    const auth =
      this.options.ytDlpAuth?.[siteId] ??
      (siteId === 'youtube'
        ? {
            cookiesPath: this.options.ytDlpCookiesPath,
            cookiesFromBrowser: this.options.ytDlpCookiesFromBrowser,
          }
        : {});
    return [
      ...(auth.cookiesPath ? ['--cookies', auth.cookiesPath] : []),
      ...(auth.cookiesFromBrowser ? ['--cookies-from-browser', auth.cookiesFromBrowser] : []),
    ];
  }
  async resolve(source: Source, { signal }: AdapterContext) {
    const { uri, args, siteId } = await this.socialSource(source);
    const raw = await runCommand(
      this.options.ytDlpPath ?? 'yt-dlp',
      [
        '--ignore-config',
        '--no-playlist',
        '--skip-download',
        '--dump-single-json',
        '--socket-timeout',
        '30',
        ...args,
        '--',
        uri,
      ],
      signal,
      this.options.timeoutMs ?? 60_000,
    );
    const data = JSON.parse(raw) as {
      title?: string;
      ext?: string;
      _type?: string;
      entries?: unknown;
    };
    if (['playlist', 'multi_video'].includes(data._type ?? '') || data.entries !== undefined)
      throw new MediaError(
        'invalid_input',
        'Playlists and multi-item posts are not supported; select a single video',
      );
    return {
      source: { ...source, uri },
      fileName: safeName(`${data.title ?? 'video'}.${data.ext ?? 'mp4'}`),
      metadata: { downloadProvider: siteId },
    };
  }
  async download(
    { source }: ResolvedSource,
    { signal }: AdapterContext,
    { directory, maxBytes }: DownloadTarget,
  ) {
    const { uri, args } = await this.socialSource(source);
    await runCommand(
      this.options.ytDlpPath ?? 'yt-dlp',
      [
        '--ignore-config',
        '--no-playlist',
        '--no-part',
        '--socket-timeout',
        '30',
        '--max-filesize',
        String(maxBytes),
        ...args,
        '-f',
        'best[ext=mp4]/best',
        '-o',
        join(directory, 'download-%(autonumber)05d.%(ext)s'),
        '--',
        uri,
      ],
      signal,
      this.options.timeoutMs,
    );
    const entries = (await readdir(directory)).filter(
      (name) => name.startsWith('download-') && !name.endsWith('.ytdl'),
    );
    if (entries.length !== 1) throw new Error('yt-dlp did not produce exactly one media file');
    return join(directory, entries[0]!);
  }
}
