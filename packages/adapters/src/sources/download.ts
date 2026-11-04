import { mkdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { MediaError, type AdapterContext, type SourceAdapter } from '@media-ingest/sdk';
import type { ResolvedSource, Source } from '@media-ingest/contracts';
import type { NodeFiles } from '../files.js';

export interface DownloadOptions {
  files: NodeFiles;
  timeoutMs?: number;
  maxDownloadBytes?: number;
}

export interface DownloadTarget {
  directory: string;
  path: string;
  maxBytes: number;
}

/** Template for a bounded, attempt-local download through the SDK source port. */
export abstract class DownloadSource<
  Options extends DownloadOptions = DownloadOptions,
> implements SourceAdapter {
  abstract readonly kind: Source['kind'];

  constructor(protected readonly options: Options) {}

  protected abstract resolveSource(
    source: Source,
    context: AdapterContext,
  ): Promise<ResolvedSource>;
  protected abstract download(
    resolved: ResolvedSource,
    context: AdapterContext,
    target: DownloadTarget,
  ): Promise<string>;
  private bounded(source: Source, context: AdapterContext): AdapterContext {
    if (source.kind !== this.kind)
      throw new MediaError('invalid_input', `Expected a ${this.kind} source`);
    return {
      ...context,
      signal: AbortSignal.any([
        context.signal,
        AbortSignal.timeout(this.options.timeoutMs ?? 15 * 60_000),
      ]),
    };
  }
  async resolve(source: Source, context: AdapterContext): Promise<ResolvedSource> {
    return this.resolveSource(source, this.bounded(source, context));
  }
  async materialize(resolved: ResolvedSource, context: AdapterContext) {
    const attempt = this.bounded(resolved.source, context);
    const directory = this.options.files.workspace(context);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const maxBytes = this.options.maxDownloadBytes ?? 1024 * 1024 * 1024;
    const path = await this.download(resolved, attempt, {
      directory,
      path: join(directory, 'source-media'),
      maxBytes,
    });
    attempt.signal.throwIfAborted();
    if ((await stat(path)).size > maxBytes)
      throw new Error('Media exceeds configured download limit');
    return this.options.files.artifact(
      path,
      resolved.fileName || basename(path),
      resolved.mimeType,
    );
  }
}
