import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AdapterContext,
  Artifact,
  Chunk,
  MediaAdapter,
  MediaChunkKind,
} from '@media-ingest/sdk';
import { NodeFiles } from './files.js';
import { runCommand } from './run-command.js';
import { mediaInputPolicy, photoFrameMs, photoInput } from './media-input.js';

export { runCommand } from './run-command.js';
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
    if (
      await photoInput(
        artifact.uri,
        context.signal,
        this.options.ffprobePath,
        this.options.timeoutMs,
      )
    )
      return { durationMs: photoFrameMs, hasAudio: false, hasVideo: true };
    const text = await runCommand(
      this.options.ffprobePath ?? 'ffprobe',
      [
        '-v',
        'error',
        ...mediaInputPolicy,
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
    const photo = await photoInput(
      artifact.uri,
      context.signal,
      this.options.ffprobePath,
      this.options.timeoutMs,
    );
    if (photo && (audio || chunk.startMs !== 0 || chunk.endMs !== photoFrameMs))
      throw new Error('Photo requires a single visual chunk');
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
        ...(photo ?? mediaInputPolicy),
        '-i',
        artifact.uri,
        '-t',
        String((chunk.endMs - chunk.startMs) / 1000),
        ...codecs,
        ...(photo
          ? ['-frames:v', '1', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-pix_fmt', 'yuv420p']
          : []),
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
