import { mkdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AdapterContext, SourceAdapter } from '@media-ingest/sdk';
import type { ResolvedSource, Source } from '@media-ingest/contracts';
import type { NodeFiles } from '../files.js';

interface DownloadOptions {
  files: NodeFiles;
  timeoutMs?: number;
  maxDownloadBytes?: number;
}

export interface DownloadTarget {
  directory: string;
  path: string;
  maxBytes: number;
}

export interface SourceDriver {
  resolve(source: Source, context: AdapterContext): Promise<ResolvedSource>;
  download(
    resolved: ResolvedSource,
    context: AdapterContext,
    target: DownloadTarget,
  ): Promise<string>;
}

// Built-in sources share attempt isolation, cancellation and artifact fingerprinting.
export function downloadAdapter(driver: SourceDriver, options: DownloadOptions): SourceAdapter {
  function bounded(context: AdapterContext): AdapterContext {
    return {
      ...context,
      signal: AbortSignal.any([
        context.signal,
        AbortSignal.timeout(options.timeoutMs ?? 15 * 60_000),
      ]),
    };
  }
  return {
    resolve(source, context) {
      return driver.resolve(source, bounded(context));
    },
    async materialize(resolved, context) {
      const directory = options.files.workspace(context);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const attempt = bounded(context);
      const maxBytes = options.maxDownloadBytes ?? 1024 * 1024 * 1024;
      const path = await driver.download(resolved, attempt, {
        directory,
        path: join(directory, 'source-media'),
        maxBytes,
      });
      attempt.signal.throwIfAborted();
      if ((await stat(path)).size > maxBytes)
        throw new Error('Media exceeds configured download limit');
      return options.files.artifact(path, resolved.fileName || basename(path), resolved.mimeType);
    },
  };
}
