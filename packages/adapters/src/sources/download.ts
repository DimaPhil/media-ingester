import { mkdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {
  MediaError,
  type AdapterContext,
  type MaterializeOptions,
  type SourceAdapter,
} from '@media-ingest/sdk';
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
  /** Only the audio stream is needed; a subclass may download less. */
  audioOnly: boolean;
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
  async materialize(
    resolved: ResolvedSource,
    context: AdapterContext,
    options: MaterializeOptions = {},
  ) {
    const attempt = this.bounded(resolved.source, context);
    const directory = this.options.files.workspace(context);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const maxBytes = this.options.maxDownloadBytes ?? 1024 * 1024 * 1024;
    const path = await this.download(resolved, attempt, {
      directory,
      path: join(directory, 'source-media'),
      maxBytes,
      audioOnly: options.audioOnly === true,
    });
    attempt.signal.throwIfAborted();
    const sizeBytes = (await stat(path)).size;
    if (sizeBytes > maxBytes) throw new Error('Media exceeds configured download limit');
    // A source may deliver another container than resolved, e.g. an audio-only stream.
    const extension = extname(path);
    const declared = extname(resolved.fileName ?? '');
    const renamed = Boolean(resolved.fileName && extension && declared !== extension);
    const artifact = await this.options.files.artifact(
      path,
      renamed
        ? `${basename(resolved.fileName!, declared)}${extension}`
        : resolved.fileName || basename(path),
      renamed ? undefined : resolved.mimeType,
    );
    return { ...artifact, sizeBytes };
  }
}
