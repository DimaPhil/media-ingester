import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AdapterContext, Artifact } from '@media-ingest/sdk';
import { MediaError } from '@media-ingest/sdk';
import type { Source } from '@media-ingest/contracts';

export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
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
export class NodeFiles {
  readonly workRoot: string;
  readonly maxUploadBytes: number;
  constructor(options: { workRoot: string; maxUploadBytes?: number }) {
    this.workRoot = resolve(options.workRoot);
    this.maxUploadBytes = options.maxUploadBytes ?? MAX_UPLOAD_BYTES;
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
    const staged = await mkdtemp(join(dirname(path), '.upload-'));
    try {
      await writeFile(join(staged, 'media'), buffer, { mode: 0o600, flag: 'wx' });
      await writeFile(join(staged, 'metadata.json'), JSON.stringify({ fileName: name }), {
        mode: 0o600,
        flag: 'wx',
      });
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
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
    return { source: { kind: 'upload', uri: id }, size: buffer.length };
  }
  async uploadMetadata(ownerId: string, id: string): Promise<{ fileName: string; path: string }> {
    const directory = this.uploadPath(ownerId, id);
    const metadata: unknown = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      !('fileName' in metadata) ||
      typeof metadata.fileName !== 'string'
    )
      throw new Error('Invalid upload metadata');
    return { fileName: safeName(metadata.fileName), path: join(directory, 'media') };
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
