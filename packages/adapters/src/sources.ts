import type { Source, ResolvedSource } from '@media-ingest/contracts';
import type { AdapterContext, SourceAdapter } from '@media-ingest/sdk';
import type { NodeFiles } from './files.js';
import { downloadAdapter } from './sources/download.js';
import { localSource } from './sources/local.js';
import { httpSource } from './sources/http.js';
import { googleDriveSource } from './sources/google-drive.js';
import { telegramSource } from './sources/telegram.js';
import { YtDlpSource, type YtDlpOptions } from './sources/yt-dlp.js';

export { driveId } from './sources/google-drive.js';
export { telegramReference } from './sources/telegram.js';
export { googleAccessToken } from './google-auth.js';

export interface NodeSourceOptions extends YtDlpOptions {
  files: NodeFiles;
  overrides?: Partial<Record<Source['kind'], SourceAdapter>>;
  maxDownloadBytes?: number;
  telegramBaseUrl?: string;
  telegramToken?: string;
  googleCredentials?: Record<string, unknown>;
}

export class NodeSources implements SourceAdapter {
  private readonly adapters: Record<Source['kind'], SourceAdapter>;

  constructor(private readonly options: NodeSourceOptions) {
    const local = downloadAdapter(localSource(options.files), options);
    const social = downloadAdapter(new YtDlpSource(options), options);
    this.adapters = {
      local_file: local,
      upload: local,
      http: downloadAdapter(httpSource, options),
      youtube: social,
      instagram: social,
      x: social,
      yt_dlp: social,
      google_drive: downloadAdapter(googleDriveSource(options.googleCredentials), options),
      telegram: downloadAdapter(
        telegramSource(options.telegramBaseUrl, options.telegramToken),
        options,
      ),
    };
  }

  private adapter(kind: Source['kind']): SourceAdapter {
    return this.options.overrides?.[kind] ?? this.adapters[kind];
  }

  resolve(source: Source, context: AdapterContext) {
    return this.adapter(source.kind).resolve(source, context);
  }

  materialize(resolved: ResolvedSource, context: AdapterContext) {
    return this.adapter(resolved.source.kind).materialize(resolved, context);
  }
}
