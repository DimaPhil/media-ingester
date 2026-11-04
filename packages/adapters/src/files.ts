import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AdapterContext, Artifact } from '@media-ingest/sdk';
import { MediaError } from '@media-ingest/sdk';
import { MAX_INLINE_MEDIA_BYTES, type Source } from '@media-ingest/contracts';

export { MAX_INLINE_MEDIA_BYTES as MAX_UPLOAD_BYTES } from '@media-ingest/contracts';

export function safeName(value: string): string {
  return (
    Array.from(basename(value.replaceAll('\\', '/')))
      .map((character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? '_' : character,
      )
      .join('')
      .slice(0, 255) || 'media'
  );
}
function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new MediaError('invalid_input', 'Invalid storage identifier');
  return value;
}

export interface UploadLifecycle {
  publish(ownerId: string, id: string, write: () => Promise<void>): Promise<void>;
  read<T>(ownerId: string, id: string, read: () => Promise<T>): Promise<T>;
}

interface UploadMetadata {
  fileName: string;
  path: string;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export class NodeFiles {
  readonly workRoot: string;
  readonly maxUploadBytes: number;
  private readonly uploadLifecycle?: UploadLifecycle;
  constructor(options: {
    workRoot: string;
    maxUploadBytes?: number;
    uploadLifecycle?: UploadLifecycle;
  }) {
    this.workRoot = resolve(options.workRoot);
    this.maxUploadBytes = options.maxUploadBytes ?? MAX_INLINE_MEDIA_BYTES;
    this.uploadLifecycle = options.uploadLifecycle;
  }
  workspace(context: AdapterContext): string {
    if (!Number.isInteger(context.attempt) || context.attempt < 0)
      throw new Error('Invalid attempt');
    return join(
      this.workRoot,
      'jobs',
      safeId(context.ownerId),
      safeId(context.jobId),
      String(context.attempt),
    );
  }
  uploadPath(ownerId: string, id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new MediaError('invalid_input', 'Invalid upload id');
    return join(this.workRoot, 'uploads', safeId(ownerId), id);
  }
  async upload(
    ownerId: string,
    fileName: string,
    data: string,
  ): Promise<{ source: Source; size: number }> {
    if (data.length > Math.ceil(this.maxUploadBytes / 3) * 4 || data.length % 4 !== 0)
      throw new MediaError('invalid_input', 'Invalid or oversized base64 upload');
    const buffer = Buffer.from(data, 'base64');
    // Decode/re-encode is linear and avoids recursive-regexp stack exhaustion
    // on ordinary multi-megabyte media while rejecting permissive decoder input.
    if (buffer.toString('base64') !== data)
      throw new MediaError('invalid_input', 'Invalid base64 upload');
    if (!buffer.length || buffer.length > this.maxUploadBytes)
      throw new MediaError(
        'invalid_input',
        `Upload must contain 1 to ${this.maxUploadBytes} bytes of data`,
      );
    const name = safeName(fileName);
    const fingerprint = createHash('sha256').update(buffer).digest('hex');
    const digest = createHash('sha256')
      .update(JSON.stringify([safeId(ownerId), name, fingerprint]))
      .digest();
    // UUIDv8 encodes our owner/name/content identity; retries upload the same URI.
    digest[6] = (digest[6]! & 0x0f) | 0x80;
    digest[8] = (digest[8]! & 0x3f) | 0x80;
    const hex = digest.subarray(0, 16).toString('hex');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const path = this.uploadPath(ownerId, id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (!(await this.isOwnerDirectory(path)))
      throw new MediaError('invalid_input', 'Invalid upload owner');
    const staged = await mkdtemp(join(dirname(path), '.upload-'));
    try {
      await writeFile(join(staged, 'media'), buffer, { mode: 0o600, flag: 'wx' });
      await writeFile(join(staged, 'metadata.json'), JSON.stringify({ fileName: name }), {
        mode: 0o600,
        flag: 'wx',
      });
      const publish = async () => {
        if (this.uploadLifecycle) {
          // Recover a removal interrupted after detaching the previous publication.
          await rm(this.detachedPath(path), { recursive: true, force: true });
        }
        try {
          await rename(staged, path);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !('code' in error) ||
            !['EEXIST', 'ENOTEMPTY'].includes(String(error.code))
          )
            throw error;
          // Another identical upload may have won the atomic directory rename.
          // Validate its complete contents; never overwrite an unexpected target.
          const existing = await this.uploadMetadata(ownerId, id);
          const artifact = await this.artifact(existing.path, existing.fileName);
          if (existing.fileName !== name || artifact.fingerprint !== fingerprint)
            throw new Error('Existing upload content does not match its identity');
        }
      };
      if (this.uploadLifecycle) await this.uploadLifecycle.publish(ownerId, id, publish);
      else await publish();
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
    return { source: { kind: 'upload', uri: id }, size: buffer.length };
  }
  /** Raw lookup for a caller that holds the lifecycle lock. Use withUpload to pin a read or copy. */
  async uploadMetadata(ownerId: string, id: string): Promise<UploadMetadata> {
    const directory = this.uploadPath(ownerId, id);
    const path = join(directory, 'media');
    try {
      if (!(await this.isOwnerDirectory(directory)))
        throw new MediaError('not_found', 'Upload not found');
      const metadata: unknown = JSON.parse(
        await readFile(join(directory, 'metadata.json'), 'utf8'),
      );
      if (
        !metadata ||
        typeof metadata !== 'object' ||
        !('fileName' in metadata) ||
        typeof metadata.fileName !== 'string'
      )
        throw new Error('Invalid upload metadata');
      const info = await lstat(path);
      if (!info.isFile() || !info.size) throw new Error('Invalid upload media');
      return { fileName: safeName(metadata.fileName), path };
    } catch (error) {
      if (isMissing(error)) throw new MediaError('not_found', 'Upload not found');
      throw error;
    }
  }

  withUpload<T>(
    ownerId: string,
    id: string,
    use: (metadata: UploadMetadata) => T | Promise<T>,
  ): Promise<T> {
    const read = async () => use(await this.uploadMetadata(ownerId, id));
    return this.uploadLifecycle ? this.uploadLifecycle.read(ownerId, id, read) : read();
  }

  private detachedPath(path: string): string {
    return join(dirname(path), `.removing-${basename(path)}`);
  }

  private async isOwnerDirectory(path: string): Promise<boolean> {
    // Refuse a symlink in the operator-owned volume that could redirect deletion outside this owner.
    for (const parent of [dirname(dirname(path)), dirname(path)]) {
      if (!(await lstat(parent)).isDirectory()) throw new Error('Invalid upload directory');
    }
    // realpath returns the stored spelling even on a case-insensitive volume.
    const parent = dirname(path);
    return basename(await realpath(parent)) === basename(parent);
  }

  /** The retention coordinator holds the owner/upload lock through this callback. */
  async removeUpload(ownerId: string, id: string): Promise<void> {
    const path = this.uploadPath(ownerId, id);
    const detached = this.detachedPath(path);
    try {
      if (!(await this.isOwnerDirectory(path))) return;
      await rm(detached, { recursive: true, force: true });
      await rename(path, detached);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    await rm(detached, { recursive: true, force: true });
  }
  async readArtifact(artifact: Artifact, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted();
    const file = await open(artifact.uri, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error('Expected a regular media file');
      const tooLarge = () =>
        new MediaError('payload_too_large', 'Download exceeds inline media size limit');
      if (info.size > maxBytes) throw tooLarge();
      const data = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < data.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(data, offset, data.length - offset);
        if (!bytesRead) throw new Error('Media file changed during download');
        offset += bytesRead;
      }
      // Reading the same descriptor prevents a path replacement or growing file from bypassing the cap.
      if ((await file.read(Buffer.alloc(1))).bytesRead) {
        if ((await file.stat()).size > maxBytes) throw tooLarge();
        throw new Error('Media file changed during download');
      }
      return data;
    } finally {
      await file.close();
    }
  }
  async artifact(path: string, fileName: string, mimeType?: string): Promise<Artifact> {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) throw new Error('Media artifact is empty or not a file');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return {
      uri: path,
      fileName: safeName(fileName),
      fingerprint: hash.digest('hex'),
      ...(mimeType ? { mimeType } : {}),
    };
  }
}
