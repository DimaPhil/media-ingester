import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFiles, safeName } from '../src/files.js';
import { NodeMedia, runCommand } from '../src/media.js';
import { NodeSources } from '../src/sources.js';
import { z } from 'zod';

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'media-adapter-'));
  roots.push(root);
  return {
    root,
    files: new NodeFiles({ workRoot: root }),
    context: {
      ownerId: 'owner',
      jobId: 'test-job',
      attempt: 1,
      signal: new AbortController().signal,
    },
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('owned media files', () => {
  it('accepts an 8 MiB base64 upload without regular-expression stack exhaustion', async () => {
    const { files } = await setup();
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0xa5);
    const upload = await files.upload('owner', 'large.mp3', bytes.toString('base64'));
    expect(upload.size).toBe(bytes.length);
    expect(
      (await readFile((await files.uploadMetadata('owner', upload.source.uri)).path)).equals(bytes),
    ).toBe(true);
  });
  it('deduplicates concurrent identical uploads atomically and scopes identity to owner and name', async () => {
    const { root, files } = await setup();
    const data = Buffer.from('same bytes').toString('base64');
    const uploads = await Promise.all(
      Array.from({ length: 8 }, () => files.upload('owner', 'clip.mp3', data)),
    );
    const id = uploads[0]!.source.uri;
    expect(new Set(uploads.map((upload) => upload.source.uri)).size).toBe(1);
    expect(z.uuid().parse(id)).toBe(id);
    expect((await files.upload('owner', '../clip.mp3', data)).source.uri).toBe(id);
    expect(
      (await files.upload('owner', 'clip.mp3', Buffer.from('changed').toString('base64'))).source
        .uri,
    ).not.toBe(id);
    expect((await files.upload('owner', 'renamed.mp3', data)).source.uri).not.toBe(id);
    const other = await files.upload('other', 'clip.mp3', data);
    expect(other.source.uri).not.toBe(id);
    await expect(files.uploadMetadata('other', id)).rejects.toThrow();
    expect(await readFile((await files.uploadMetadata('owner', id)).path, 'utf8')).toBe(
      'same bytes',
    );
    expect(
      (await readdir(join(root, 'uploads', 'owner'))).filter((name) => name.startsWith('.upload-')),
    ).toEqual([]);
  });
  it('preserves unexpected existing content instead of overwriting it during deduplication', async () => {
    const { files } = await setup();
    const data = Buffer.from('original').toString('base64');
    const upload = await files.upload('owner', 'clip.mp3', data);
    const metadata = await files.uploadMetadata('owner', upload.source.uri);
    await writeFile(metadata.path, 'unexpected');
    await expect(files.upload('owner', 'clip.mp3', data)).rejects.toThrow('does not match');
    expect(await readFile(metadata.path, 'utf8')).toBe('unexpected');
  });
  it('stores uploads with opaque IDs, cleans names and isolates owners', async () => {
    const { files, context } = await setup();
    const upload = await files.upload(
      'owner',
      '../../unsafe\u0000.mp3',
      Buffer.from('audio').toString('base64'),
    );
    expect(upload.size).toBe(5);
    expect(upload.source.kind).toBe('upload');
    const metadata = await files.uploadMetadata('owner', upload.source.uri);
    expect(metadata.fileName).toBe('unsafe_.mp3');
    await expect(files.uploadMetadata('another', upload.source.uri)).rejects.toThrow();
    expect(() => files.uploadPath('../owner', upload.source.uri)).toThrow();
    expect(() => files.uploadPath('owner', '../../secret')).toThrow();
    expect(() => files.workspace({ ...context, attempt: -1 })).toThrow();
    expect(safeName('C:\\folder\\file.mp3')).toBe('file.mp3');
    expect(safeName('')).toBe('media');
    const sources = new NodeSources({ files });
    const resolved = await sources.resolve(upload.source, context);
    const artifact = await sources.materialize(resolved, context);
    expect(artifact.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(artifact.uri, 'utf8')).toBe('audio');
    await new NodeMedia({ files }).cleanup(context);
    await expect(readFile(artifact.uri)).rejects.toThrow();
    expect(await readFile(metadata.path, 'utf8')).toBe('audio');
  });
  it('rejects invalid, empty and oversized uploads and corrupt metadata', async () => {
    const { root, files } = await setup();
    await expect(files.upload('owner', 'name', 'bad!')).rejects.toThrow();
    await expect(files.upload('owner', 'name', '')).rejects.toThrow();
    const small = new NodeFiles({ workRoot: root, maxUploadBytes: 2 });
    await expect(small.upload('owner', 'name', 'YWJj')).rejects.toThrow();
    const upload = await files.upload('owner', 'name', 'YWJj');
    await writeFile(join(files.uploadPath('owner', upload.source.uri), 'metadata.json'), '{}');
    await expect(files.uploadMetadata('owner', upload.source.uri)).rejects.toThrow();
    const path = join(root, 'empty');
    await writeFile(path, '');
    await expect(files.artifact(path, 'empty')).rejects.toThrow();
  });
  it('materializes SDK local files and enforces download limits', async () => {
    const { root, files, context } = await setup();
    const path = join(root, 'file');
    await writeFile(path, '12345');
    const sources = new NodeSources({ files });
    const resolved = await sources.resolve({ kind: 'local_file', uri: path }, context);
    expect(resolved.metadata.size).toBe(5);
    expect((await sources.materialize(resolved, context)).fileName).toBe('file');
    await expect(
      new NodeSources({ files, maxDownloadBytes: 2 }).materialize(resolved, context),
    ).rejects.toThrow('limit');
    await expect(sources.resolve({ kind: 'local_file', uri: root }, context)).rejects.toThrow(
      'regular file',
    );
  });
});
describe('ffmpeg adapter', () => {
  it('keeps a full subscription audio chunk at exactly sixty seconds without encoder padding', async () => {
    const { root, files, context } = await setup();
    const path = join(root, 'minute.wav');
    await runCommand(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=61',
        '-y',
        path,
      ],
      context.signal,
    );
    const media = new NodeMedia({ files });
    const chunk = await media.chunk(
      await files.artifact(path, 'minute.wav', 'audio/wav'),
      { index: 0, startMs: 0, endMs: 60000 },
      'audio_pcm',
      context,
    );
    expect(chunk.mimeType).toBe('audio/wav');
    expect(chunk.durationMs).toBe(60000);
    expect((await media.inspect(chunk, context)).durationMs).toBe(60000);
  });
  it('preserves native video for video input and extracts audio only when selected', async () => {
    const { root, files, context } = await setup();
    const path = join(root, 'video.mp4');
    await runCommand(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=64x64:r=10:d=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        '-y',
        path,
      ],
      context.signal,
    );
    const artifact = await files.artifact(path, 'video.mp4', 'video/mp4');
    const media = new NodeMedia({ files });
    for (const kind of ['video', 'understanding'] as const) {
      const chunk = await media.chunk(
        artifact,
        { index: 0, startMs: 0, endMs: 500 },
        kind,
        context,
      );
      expect(chunk.mimeType).toBe('video/mp4');
      expect(chunk.fileName).toMatch(/\.mp4$/);
      const inspection = await media.inspect(chunk, context);
      expect(inspection.hasVideo).toBe(true);
      expect(inspection.hasAudio).toBe(true);
    }
    const audio = await media.chunk(
      artifact,
      { index: 1, startMs: 0, endMs: 500 },
      'audio',
      context,
    );
    expect(audio.mimeType).toBe('audio/mpeg');
    const audioInspection = await media.inspect(audio, context);
    expect(audioInspection.hasVideo).toBe(false);
    expect(audioInspection.hasAudio).toBe(true);
  });

  it('probes and chunks real generated media', async () => {
    const { root, files, context } = await setup();
    const path = join(root, 'tone.wav');
    await runCommand(
      'ffmpeg',
      ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-y', path],
      context.signal,
    );
    const artifact = await files.artifact(path, 'tone.wav', 'audio/wav');
    const media = new NodeMedia({ files });
    const info = await media.inspect(artifact, context);
    expect(info.hasAudio).toBe(true);
    expect(info.hasVideo).toBe(false);
    expect(info.durationMs).toBe(1000);
    const chunk = await media.chunk(
      artifact,
      { index: 0, startMs: 0, endMs: 500 },
      'transcription',
      context,
    );
    expect(chunk.mimeType).toBe('audio/mpeg');
    expect((await media.inspect(chunk, context)).durationMs).toBeGreaterThan(400);
    await expect(
      media.chunk(artifact, { index: -1, startMs: 0, endMs: 500 }, 'transcription', context),
    ).rejects.toThrow('Invalid');
    const controller = new AbortController();
    controller.abort();
    await expect(runCommand('ffmpeg', ['-version'], controller.signal)).rejects.toThrow();
  });
});
