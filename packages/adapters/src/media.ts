import { mkdir, open, rm } from 'node:fs/promises';
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

export { runCommand } from './run-command.js';
// A photo occupies one 25 fps frame on the provider transport timeline.
const photoFrameMs = 40;
const maxPhotoPixels = 32_000_000;
// Reject playlist/concat demuxers and network protocols in untrusted uploads.
const inputPolicy = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mp3,wav,flac,ogg,aac,avi,mpeg,mpegts,asf,aiff',
];
export class NodeMedia implements MediaAdapter {
  constructor(
    private readonly options: {
      files: NodeFiles;
      ffmpegPath?: string;
      ffprobePath?: string;
      timeoutMs?: number;
    },
  ) {}
  private async photoInput(artifact: Artifact, context: AdapterContext): Promise<string[] | null> {
    const file = await open(artifact.uri, 'r');
    let demuxer: string;
    try {
      const header = Buffer.alloc(12);
      await file.read(header, 0, header.length, 0);
      if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) demuxer = 'jpeg_pipe';
      else if (header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
        demuxer = 'png_pipe';
      else if (
        header.toString('ascii', 0, 4) === 'RIFF' &&
        header.toString('ascii', 8, 12) === 'WEBP'
      )
        demuxer = 'webp_pipe';
      else return null;
      const { size } = await file.stat();
      if (size > 32 * 1024 * 1024) throw new Error('Photo exceeds 32 MiB');
      if (demuxer !== 'jpeg_pipe') {
        // Piped demuxers can expose only the first frame of an animation.
        const data = await file.readFile();
        const png = demuxer === 'png_pipe';
        for (let offset = png ? 8 : 12; offset < data.length;) {
          if (data.length - offset < (png ? 12 : 8)) throw new Error('Invalid photo chunk');
          const nameOffset = offset + (png ? 4 : 0);
          const name = data.toString('latin1', nameOffset, nameOffset + 4);
          if (['acTL', 'fcTL', 'fdAT', 'ANIM', 'ANMF'].includes(name))
            throw new Error('Animated photos are unsupported');
          const length = png ? data.readUInt32BE(offset) : data.readUInt32LE(offset + 4);
          offset += length + (png ? 12 : 8 + (length % 2));
          if (offset > data.length || (name === 'IEND' && offset !== data.length))
            throw new Error('Invalid photo chunk');
        }
      }
    } finally {
      await file.close();
    }
    // Explicit pipe demuxer prevents numbered images from loading sibling files.
    const args = [
      '-protocol_whitelist',
      'file',
      '-format_whitelist',
      demuxer,
      '-f',
      demuxer,
      '-max_pixels',
      String(maxPhotoPixels),
    ];
    const probe = await runCommand(
      this.options.ffprobePath ?? 'ffprobe',
      [
        '-v',
        'error',
        ...args,
        '-read_intervals',
        '%+#2',
        '-count_packets',
        '-show_entries',
        'stream=width,height,nb_read_packets',
        '-of',
        'json',
        artifact.uri,
      ],
      context.signal,
      this.options.timeoutMs ?? 60_000,
    );
    const { streams } = JSON.parse(probe) as {
      streams: { width: number; height: number; nb_read_packets?: string }[];
    };
    const frame = streams[0];
    if (
      streams.length !== 1 ||
      !frame ||
      frame.nb_read_packets !== '1' ||
      !(frame.width > 0 && frame.height > 0 && frame.width * frame.height <= maxPhotoPixels)
    )
      throw new Error('Expected one bounded photo frame');
    return args;
  }
  async inspect(artifact: Artifact, context: AdapterContext) {
    if (await this.photoInput(artifact, context))
      return { durationMs: photoFrameMs, hasAudio: false, hasVideo: true };
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
    const photo = await this.photoInput(artifact, context);
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
        ...(photo ?? inputPolicy),
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
