import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Source, ResolvedSource } from '@media-ingest/contracts';
import { type AdapterContext, MediaError } from '@media-ingest/sdk';
import { publicUrl } from '../safe-fetch.js';
import { runCommand } from '../run-command.js';
import { safeName } from '../files.js';
import type { YtDlpSourceRegistry, YtDlpSiteAuth } from '../source-registry.js';
import { DownloadSource, type DownloadOptions, type DownloadTarget } from './download.js';

export interface YtDlpOptions extends DownloadOptions {
  ytDlpPath?: string;
  ytDlpAllowedHosts?: string[];
  ytDlpAuth?: Record<string, YtDlpSiteAuth>;
}
export abstract class YtDlpSourceBase extends DownloadSource<YtDlpOptions> {
  constructor(
    options: YtDlpOptions,
    private readonly registry: YtDlpSourceRegistry,
  ) {
    super(options);
  }
  protected selectSite(source: Source) {
    return this.registry.select(source);
  }
  private async socialSource(
    source: Source,
  ): Promise<{ uri: string; args: string[]; siteId: string }> {
    const { site, url } = this.selectSite(source);
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
    const auth = this.options.ytDlpAuth?.[siteId] ?? {};
    return [
      ...(auth.cookiesPath ? ['--cookies', auth.cookiesPath] : []),
      ...(auth.cookiesFromBrowser ? ['--cookies-from-browser', auth.cookiesFromBrowser] : []),
    ];
  }
  protected async resolveSource(source: Source, { signal }: AdapterContext) {
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
      id?: string;
      title?: string;
      ext?: string;
      _type?: string;
      entries?: unknown;
      duration?: number;
      availability?: string;
      age_limit?: number;
      is_live?: boolean;
      live_status?: string;
    };
    if (['playlist', 'multi_video'].includes(data._type ?? '') || data.entries !== undefined)
      throw new MediaError(
        'invalid_input',
        'Playlists and multi-item posts are not supported; select a single video',
      );
    return {
      source: { ...source, uri },
      fileName: safeName(`${data.title ?? 'video'}.${data.ext ?? 'mp4'}`),
      metadata: {
        downloadProvider: siteId,
        ...(typeof data.id === 'string' ? { mediaId: data.id } : {}),
        ...(data.title ? { title: data.title } : {}),
        // Site facts that let a provider read the media remotely; absent values disable that.
        ...(typeof data.duration === 'number' && data.duration > 0
          ? { durationMs: Math.round(data.duration * 1000) }
          : {}),
        ...(typeof data.availability === 'string' ? { availability: data.availability } : {}),
        ...(typeof data.age_limit === 'number' ? { ageLimit: data.age_limit } : {}),
        ...(typeof data.live_status === 'string' || typeof data.is_live === 'boolean'
          ? {
              live:
                data.is_live === true ||
                !['not_live', 'was_live'].includes(data.live_status ?? 'not_live'),
            }
          : {}),
      },
    };
  }
  protected async download(
    { source }: ResolvedSource,
    { signal }: AdapterContext,
    { directory, maxBytes, audioOnly }: DownloadTarget,
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
        // Audio-only formats are far smaller; muxed formats remain the fallback.
        audioOnly ? 'bestaudio/best[ext=mp4]/best' : 'best[ext=mp4]/best',
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
