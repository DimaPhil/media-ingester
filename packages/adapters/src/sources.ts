import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { GoogleAuth } from 'google-auth-library';
import type { AdapterContext, Artifact, SourceAdapter } from '@media-ingest/sdk';
import { MediaError } from '@media-ingest/sdk';
import type { ResolvedSource, Source } from '@media-ingest/contracts';
import { NodeFiles, safeName } from './files.js';
import { runCommand } from './media.js';
import { publicUrl, safeRequest, saveStream } from './safe-fetch.js';
import {
  YtDlpSourceRegistry,
  type YtDlpSiteAuth,
  type YtDlpSiteDefinition,
} from './source-registry.js';

export interface NodeSourceOptions {
  files: NodeFiles;
  maxDownloadBytes?: number;
  timeoutMs?: number;
  ytDlpPath?: string;
  ytDlpAllowedHosts?: string[];
  ytDlpSites?: YtDlpSiteDefinition[];
  ytDlpAuth?: Record<string, YtDlpSiteAuth>;
  ytDlpCookiesPath?: string;
  ytDlpCookiesFromBrowser?: string;
  telegramBaseUrl?: string;
  telegramToken?: string;
  googleCredentials?: Record<string, unknown>;
}
function sourceUrl(uri: string): URL {
  try {
    return new URL(uri);
  } catch {
    throw new MediaError('invalid_input', 'Source URL must be absolute');
  }
}
export function driveId(uri: string): string {
  const url = sourceUrl(uri);
  if (
    url.protocol !== 'https:' ||
    !['drive.google.com', 'docs.google.com'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new MediaError('invalid_input', 'Invalid Google Drive URL');
  const id = url.searchParams.get('id') ?? url.pathname.match(/\/d\/([^/]+)/)?.[1];
  if (!id || !/^[\w-]+$/.test(id) || url.pathname.includes('/folders/'))
    throw new MediaError('invalid_input', 'Expected a single Google Drive file');
  return id;
}
export function telegramReference(uri: string): { chat: string; message: number } {
  const url = sourceUrl(uri);
  if (
    url.protocol !== 'https:' ||
    !['t.me', 'telegram.me'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new MediaError('invalid_input', 'Invalid Telegram URL');
  const parts = url.pathname.split('/').filter(Boolean);
  const privatePost = parts[0] === 'c';
  const chat = privatePost ? `-100${parts[1]}` : `@${parts[0]}`;
  const message = Number(parts[privatePost ? 2 : 1]);
  if (!Number.isSafeInteger(message) || message < 1 || !/^(@[\w]+|-100\d+)$/.test(chat))
    throw new MediaError('invalid_input', 'Expected a single Telegram post');
  return { chat, message };
}
export async function googleAccessToken(credentials?: Record<string, unknown>): Promise<string> {
  const auth = new GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
  const token = await auth.getAccessToken();
  if (!token) throw new Error('Google credentials did not yield an access token');
  return token;
}
async function checkedFetch(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'error' });
  if (!response.ok) throw new Error(`Source service returned HTTP ${response.status}`);
  return response;
}
export class NodeSources implements SourceAdapter {
  private readonly registry: YtDlpSourceRegistry;
  constructor(private readonly options: NodeSourceOptions) {
    this.registry = new YtDlpSourceRegistry(options.ytDlpSites);
  }
  private signal(context: AdapterContext): AbortSignal {
    return AbortSignal.any([
      context.signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 15 * 60_000),
    ]);
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
  private telegramUrl(path: string): string {
    if (!this.options.telegramBaseUrl)
      throw new Error('Telegram source requires TELEGRAM_PROXY_URL');
    const base = new URL(this.options.telegramBaseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
      throw new Error('Invalid Telegram proxy configuration');
    return `${base.href.replace(/\/$/, '')}${path}`;
  }
  private telegramHeaders(): Record<string, string> {
    return this.options.telegramToken
      ? { Authorization: `Bearer ${this.options.telegramToken}` }
      : {};
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
  async resolve(source: Source, context: AdapterContext): Promise<ResolvedSource> {
    const signal = this.signal(context);
    switch (source.kind) {
      case 'upload': {
        const metadata = await this.options.files.uploadMetadata(context.ownerId, source.uri);
        return { source, fileName: metadata.fileName, metadata: {} };
      }
      case 'local_file': {
        const info = await stat(source.uri);
        if (!info.isFile()) throw new Error('Local source must be a regular file');
        return { source, fileName: safeName(source.uri), metadata: { size: info.size } };
      }
      case 'http': {
        const response = await safeRequest(source.uri, { signal, method: 'HEAD' });
        response.resume();
        const mimeType = response.headers['content-type'];
        return {
          source,
          fileName: safeName(new URL(source.uri).pathname),
          ...(mimeType ? { mimeType } : {}),
          metadata: {},
        };
      }
      case 'youtube':
      case 'instagram':
      case 'x':
      case 'yt_dlp': {
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
      case 'google_drive': {
        const id = driveId(source.uri);
        const token = await googleAccessToken(this.options.googleCredentials);
        const response = await checkedFetch(
          `https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType,size&supportsAllDrives=true`,
          { signal, headers: { Authorization: `Bearer ${token}` } },
        );
        const data = (await response.json()) as { name?: string; mimeType?: string };
        if (!data.name) throw new Error('Drive file name is missing');
        return {
          source,
          fileName: safeName(data.name),
          ...(data.mimeType ? { mimeType: data.mimeType } : {}),
          metadata: { id },
        };
      }
      case 'telegram': {
        const { chat, message } = telegramReference(source.uri);
        const headers = this.telegramHeaders();
        const response = await checkedFetch(
          this.telegramUrl(`/resolve?value=${encodeURIComponent(chat)}`),
          { signal, headers },
        );
        const data = (await response.json()) as { data?: { peer?: { id?: string } } };
        const chatId = data.data?.peer?.id;
        if (!chatId) throw new Error('Telegram chat was not resolved');
        const manifest = await checkedFetch(
          this.telegramUrl(`/chats/${encodeURIComponent(chatId)}/messages/${message}/media`),
          { signal, headers },
        );
        const media = (await manifest.json()) as {
          data?: Array<{ media_id: string; file_name?: string; mime_type?: string }>;
        };
        if (media.data?.length !== 1 || !media.data[0]?.media_id)
          throw new Error('Telegram post must contain exactly one media item');
        const item = media.data[0];
        return {
          source,
          fileName: safeName(item.file_name ?? 'telegram-media'),
          ...(item.mime_type ? { mimeType: item.mime_type } : {}),
          metadata: { chatId, message, mediaId: item.media_id },
        };
      }
    }
  }
  async materialize(resolved: ResolvedSource, context: AdapterContext): Promise<Artifact> {
    const { source } = resolved;
    const directory = this.options.files.workspace(context);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let path = join(directory, 'source-media');
    const signal = this.signal(context);
    const maxBytes = this.options.maxDownloadBytes ?? 1024 * 1024 * 1024;
    if (source.kind === 'local_file' || source.kind === 'upload') {
      const origin =
        source.kind === 'upload'
          ? (await this.options.files.uploadMetadata(context.ownerId, source.uri)).path
          : source.uri;
      if ((await stat(origin)).size > maxBytes)
        throw new Error('Media exceeds configured download limit');
      await copyFile(origin, path);
    } else if (source.kind === 'http') {
      await saveStream(await safeRequest(source.uri, { signal }), path, maxBytes, signal);
    } else if (['youtube', 'instagram', 'x', 'yt_dlp'].includes(source.kind)) {
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
      path = join(directory, entries[0]!);
    } else {
      let response: Response;
      if (source.kind === 'google_drive') {
        const token = await googleAccessToken(this.options.googleCredentials);
        response = await checkedFetch(
          `https://www.googleapis.com/drive/v3/files/${driveId(source.uri)}?alt=media&supportsAllDrives=true`,
          { signal, headers: { Authorization: `Bearer ${token}` } },
        );
      } else {
        const { chatId, message, mediaId } = resolved.metadata;
        response = await checkedFetch(
          this.telegramUrl(
            `/chats/${encodeURIComponent(String(chatId))}/messages/${encodeURIComponent(String(message))}/media/${encodeURIComponent(String(mediaId))}`,
          ),
          { signal, headers: this.telegramHeaders() },
        );
      }
      if (!response.body) throw new Error('Source service returned an empty body');
      const reader = response.body.getReader();
      async function* chunks() {
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            yield next.value;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      await saveStream(Readable.from(chunks()), path, maxBytes, signal);
    }
    signal.throwIfAborted();
    if ((await stat(path)).size > maxBytes)
      throw new Error('Media exceeds configured download limit');
    return this.options.files.artifact(
      path,
      resolved.fileName || basename(path),
      resolved.mimeType,
    );
  }
}
