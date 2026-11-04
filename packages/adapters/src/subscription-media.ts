import { join } from 'node:path';
import {
  MediaError,
  type Artifact,
  type AdapterContext,
  type ChunkOutput,
} from '@media-ingest/sdk';
import { runCommand } from './run-command.js';
import { mediaInputPolicy } from './media-input.js';
import { transcribeCodexAudio } from './codex-audio.js';
import type { Frame, SubscriptionUnderstandingOptions } from './reasoning/reasoner.js';

export const frameIntervalMs = 5_000;

export async function prepareSubscriptionMedia(
  artifact: Artifact,
  context: AdapterContext,
  options: SubscriptionUnderstandingOptions,
  workspace: string,
) {
  const probe = JSON.parse(
    await runCommand(
      options.ffprobePath ?? 'ffprobe',
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
      60_000,
    ),
  ) as { format?: { duration?: string }; streams?: { codec_type?: string }[] };
  const probedDurationMs = Math.round(Number(probe.format?.duration) * 1000);
  const durationMs = artifact.durationMs ?? probedDurationMs;
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    durationMs > 60_000 ||
    !Number.isFinite(probedDurationMs) ||
    probedDurationMs <= 0 ||
    probedDurationMs > durationMs + 250
  )
    throw new MediaError(
      'subscription_invalid_media',
      'Subscription understanding requires a positive clip of at most 60 seconds',
    );
  const audio = probe.streams?.some((stream) => stream.codec_type === 'audio');
  const video = probe.streams?.some((stream) => stream.codec_type === 'video');
  if (!audio && !video)
    throw new MediaError('subscription_invalid_media', 'No audio or video stream was found');
  // Finish speech recognition before a reasoning process is started or receives any context.
  let transcript: ChunkOutput | null = null;
  if (audio) {
    const audioPath = join(workspace, 'audio.wav');
    await runCommand(
      options.ffmpegPath ?? 'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-y',
        ...mediaInputPolicy,
        '-i',
        artifact.uri,
        '-t',
        String(durationMs / 1000),
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        audioPath,
      ],
      context.signal,
      60_000,
    );
    transcript = await transcribeCodexAudio(
      { ...artifact, uri: audioPath, fileName: 'audio.wav', mimeType: 'audio/wav', durationMs },
      context,
      options,
    );
  }
  const frames: Frame[] = [];
  if (video)
    for (
      let timestampMs = 0;
      timestampMs < durationMs && frames.length < 12;
      timestampMs += frameIntervalMs
    ) {
      const path = join(workspace, `frame-${frames.length}.jpg`);
      await runCommand(
        options.ffmpegPath ?? 'ffmpeg',
        [
          '-nostdin',
          '-v',
          'error',
          '-y',
          '-ss',
          String(timestampMs / 1000),
          ...mediaInputPolicy,
          '-i',
          artifact.uri,
          '-frames:v',
          '1',
          '-vf',
          'scale=640:640:force_original_aspect_ratio=decrease',
          '-q:v',
          '3',
          path,
        ],
        context.signal,
        60_000,
      );
      frames.push({ path, timestampMs });
    }
  return { frames, durationMs, transcript };
}
