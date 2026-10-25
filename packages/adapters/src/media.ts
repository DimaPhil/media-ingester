import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AdapterContext,
  Artifact,
  Chunk,
  MediaAdapter,
  MediaChunkKind,
} from '@media-ingest/sdk';
import { NodeFiles } from './files.js';

const execute = promisify(execFile);
// Reject playlist/concat demuxers and network protocols in untrusted uploads.
const inputPolicy = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mp3,wav,flac,ogg,aac,avi,mpeg,mpegts,asf,aiff',
];
export async function runCommand(
  binary: string,
  args: string[],
  signal: AbortSignal,
  timeout = 15 * 60 * 1000,
): Promise<string> {
  const result = await execute(binary, args, {
    signal,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.stdout;
}
export class NodeMedia implements MediaAdapter {
  constructor(
    private readonly options: {
      files: NodeFiles;
      ffmpegPath?: string;
      ffprobePath?: string;
      timeoutMs?: number;
    },
  ) {}
  async inspect(artifact: Artifact, context: AdapterContext) {
    const text = await runCommand(
      this.options.ffprobePath ?? 'ffprobe',
      [
        '-v',
        'error',
        ...inputPolicy,
        '-show_streams',
        '-show_format',
        '-print_format',
        'json',
        artifact.uri,
      ],
      context.signal,
      this.options.timeoutMs ?? 60_000,
    );
    const data = JSON.parse(text) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string }>;
    };
    const durationMs = Math.round(Number(data.format?.duration) * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0)
      throw new Error('Media duration must be finite and positive');
    return {
      durationMs,
      hasAudio: data.streams?.some((s) => s.codec_type === 'audio') ?? false,
      hasVideo: data.streams?.some((s) => s.codec_type === 'video') ?? false,
    };
  }
  async chunk(
    artifact: Artifact,
    chunk: Chunk,
    kind: MediaChunkKind,
    context: AdapterContext,
  ): Promise<Artifact> {
    if (
      !Number.isSafeInteger(chunk.index) ||
      chunk.index < 0 ||
      !Number.isFinite(chunk.startMs) ||
      chunk.startMs < 0 ||
      !Number.isFinite(chunk.endMs) ||
      chunk.endMs <= chunk.startMs
    )
      throw new Error('Invalid media chunk');
    const directory = this.options.files.workspace(context);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const pcm = kind === 'audio_pcm';
    const audio = kind === 'transcription' || kind === 'audio' || pcm;
    const fileName = `chunk-${chunk.index}.${pcm ? 'wav' : audio ? 'mp3' : 'mp4'}`;
    const destination = join(directory, fileName);
    const codecs = audio
      ? ['-vn', '-ac', '1', '-ar', '16000', ...(pcm ? ['-c:a', 'pcm_s16le'] : ['-b:a', '64k'])]
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac'];
    await runCommand(
      this.options.ffmpegPath ?? 'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-ss',
        String(chunk.startMs / 1000),
        ...inputPolicy,
        '-i',
        artifact.uri,
        '-t',
        String((chunk.endMs - chunk.startMs) / 1000),
        ...codecs,
        destination,
      ],
      context.signal,
      this.options.timeoutMs,
    );
    return {
      ...(await this.options.files.artifact(
        destination,
        fileName,
        pcm ? 'audio/wav' : audio ? 'audio/mpeg' : 'video/mp4',
      )),
      durationMs: chunk.endMs - chunk.startMs,
    };
  }
  async cleanup(context: AdapterContext): Promise<void> {
    await rm(this.options.files.workspace(context), { recursive: true, force: true });
  }
}
