import type { Source, ResolvedSource } from '@media-ingest/contracts';
import type { AdapterContext, SourceAdapter } from '@media-ingest/sdk';
import { YtDlpSourceRegistry, type YtDlpSiteDefinition } from './source-registry.js';
import type { YtDlpOptions } from './sources/yt-dlp-base.js';
import { LocalFileSource } from './sources/local.js';
import { UploadSource } from './sources/upload.js';
import { HttpSource } from './sources/http.js';
import { GoogleDriveSource } from './sources/google-drive.js';
import { TelegramSource } from './sources/telegram.js';
import { YouTubeSource } from './sources/youtube.js';
import { InstagramSource } from './sources/instagram.js';
import { XSource } from './sources/x.js';
import { YtDlpSource } from './sources/yt-dlp.js';

export {
  LocalFileSource,
  UploadSource,
  HttpSource,
  GoogleDriveSource,
  TelegramSource,
  YouTubeSource,
  InstagramSource,
  XSource,
  YtDlpSource,
};
export { DownloadSource, type DownloadOptions, type DownloadTarget } from './sources/download.js';
export { YtDlpSourceBase, type YtDlpOptions } from './sources/yt-dlp-base.js';

export { driveId } from './sources/google-drive.js';
export { telegramReference } from './sources/telegram.js';
export { googleAccessToken } from './google-auth.js';

export interface NodeSourceOptions extends YtDlpOptions {
  ytDlpSites?: YtDlpSiteDefinition[];
  ytDlpCookiesPath?: string;
  ytDlpCookiesFromBrowser?: string;
  overrides?: Partial<Record<Source['kind'], SourceAdapter>>;
  telegramBaseUrl?: string;
  telegramToken?: string;
  googleCredentials?: Record<string, unknown>;
}

export class NodeSources implements SourceAdapter {
  private readonly adapters: { [K in Source['kind']]: SourceAdapter & { readonly kind: K } };
  private readonly overrides?: NodeSourceOptions['overrides'];

  constructor({
    files,
    timeoutMs,
    maxDownloadBytes,
    googleCredentials,
    telegramBaseUrl,
    telegramToken,
    overrides,
    ytDlpPath,
    ytDlpAllowedHosts,
    ytDlpSites,
    ytDlpAuth,
    ytDlpCookiesPath,
    ytDlpCookiesFromBrowser,
  }: NodeSourceOptions) {
    this.overrides = overrides;
    const download = { files, timeoutMs, maxDownloadBytes };
    const social = {
      ...download,
      ytDlpPath,
      ytDlpAllowedHosts,
      // Legacy credentials configure only the YouTube extractor.
      ytDlpAuth: {
        youtube: { cookiesPath: ytDlpCookiesPath, cookiesFromBrowser: ytDlpCookiesFromBrowser },
        ...ytDlpAuth,
      },
    };
    const sites = new YtDlpSourceRegistry(ytDlpSites);
    this.adapters = {
      local_file: new LocalFileSource(download),
      upload: new UploadSource(download),
      http: new HttpSource(download),
      youtube: new YouTubeSource(social, sites),
      instagram: new InstagramSource(social, sites),
      x: new XSource(social, sites),
      yt_dlp: new YtDlpSource(social, sites),
      google_drive: new GoogleDriveSource(download, googleCredentials),
      telegram: new TelegramSource(download, telegramBaseUrl, telegramToken),
    };
  }

  private adapter(kind: Source['kind']): SourceAdapter {
    return this.overrides?.[kind] ?? this.adapters[kind];
  }

  resolve(source: Source, context: AdapterContext) {
    return this.adapter(source.kind).resolve(source, context);
  }

  materialize(resolved: ResolvedSource, context: AdapterContext) {
    return this.adapter(resolved.source.kind).materialize(resolved, context);
  }
}
