import { open } from 'node:fs/promises';
import { runCommand } from './run-command.js';

// A photo occupies one 25 fps frame on the provider transport timeline.
export const photoFrameMs = 40;
const maxPhotoPixels = 32_000_000;

// Reject playlist/concat demuxers and network protocols in untrusted uploads.
export const mediaInputPolicy = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mp3,wav,flac,ogg,aac,avi,mpeg,mpegts,asf,aiff',
] as const;

async function detectPhotoDemuxer(path: string): Promise<string | null> {
  const file = await open(path, 'r');
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
    return demuxer;
  } finally {
    await file.close();
  }
}

export async function photoInput(
  path: string,
  signal: AbortSignal,
  ffprobePath = 'ffprobe',
  timeoutMs = 60_000,
): Promise<string[] | null> {
  const demuxer = await detectPhotoDemuxer(path);
  if (!demuxer) return null;
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
    ffprobePath,
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
      path,
    ],
    signal,
    timeoutMs,
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
