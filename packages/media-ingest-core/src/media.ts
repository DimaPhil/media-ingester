import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

const execFile = promisify(execFileCb);

export interface MediaInspection {
  path: string;
  formatName: string | null;
  durationMs: number;
  sizeBytes: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
}

export interface ProviderCapability {
  maxWholeFileDurationMs: number;
  chunkDurationMs: number;
  overlapMs: number;
}

export interface PlannedChunk {
  index: number;
  startMs: number;
  endMs: number;
}

function secondsToMs(value: number | undefined): number {
  if (!value || Number.isNaN(value)) {
    return 0;
  }
  return Math.round(value * 1000);
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function safeRemove(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

export async function probeMedia(path: string): Promise<MediaInspection> {
  const { stdout } = await execFile('ffprobe', [
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-print_format',
    'json',
    path,
  ]);
  const parsed = JSON.parse(stdout) as {
    format?: { format_name?: string; duration?: string; size?: string };
    streams?: Array<{ codec_type?: string }>;
  };
  const streams = parsed.streams ?? [];
  return {
    path,
    formatName: parsed.format?.format_name ?? null,
    durationMs: secondsToMs(parsed.format?.duration ? Number(parsed.format.duration) : 0),
    sizeBytes: parsed.format?.size ? Number(parsed.format.size) : null,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    hasVideo: streams.some((stream) => stream.codec_type === 'video'),
  };
}

export function planChunks(
  inspection: MediaInspection,
  capability: ProviderCapability,
): PlannedChunk[] {
  if (inspection.durationMs <= capability.maxWholeFileDurationMs) {
    return [
      {
        index: 0,
        startMs: 0,
        endMs: inspection.durationMs,
      },
    ];
  }
  const chunks: PlannedChunk[] = [];
  let cursor = 0;
  let index = 0;
  while (cursor < inspection.durationMs) {
    const endMs = Math.min(cursor + capability.chunkDurationMs, inspection.durationMs);
    chunks.push({
      index,
      startMs: Math.max(0, cursor - (index === 0 ? 0 : capability.overlapMs)),
      endMs,
    });
    cursor += capability.chunkDurationMs;
    index += 1;
  }
  return chunks;
}

async function runFfmpeg(args: string[]): Promise<void> {
  await execFile('ffmpeg', ['-y', ...args], { maxBuffer: 1024 * 1024 * 8 });
}

export async function createAudioChunk(
  inputPath: string,
  chunk: PlannedChunk,
  outputPath: string,
): Promise<string> {
  await ensureDirectory(dirname(outputPath));
  await runFfmpeg([
    '-ss',
    `${chunk.startMs / 1000}`,
    '-t',
    `${Math.max(0.5, (chunk.endMs - chunk.startMs) / 1000)}`,
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-b:a',
    '64k',
    outputPath,
  ]);
  return outputPath;
}

export async function createVideoChunk(
  inputPath: string,
  chunk: PlannedChunk,
  outputPath: string,
): Promise<string> {
  await ensureDirectory(dirname(outputPath));
  await runFfmpeg([
    '-ss',
    `${chunk.startMs / 1000}`,
    '-t',
    `${Math.max(0.5, (chunk.endMs - chunk.startMs) / 1000)}`,
    '-i',
    inputPath,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-c:a',
    'aac',
    outputPath,
  ]);
  return outputPath;
}

export function defaultChunkPath(
  workingDirectory: string,
  operationId: string,
  chunkIndex: number,
  extension: 'mp3' | 'mp4',
): string {
  return join(workingDirectory, operationId, 'chunks', `chunk-${chunkIndex}.${extension}`);
}
