import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { streamAudio } from './codex-realtime.js';
import { mediaInputPolicy } from './media-input.js';
export { CodexTranscript } from './codex-realtime.js';
import {
  MediaError,
  type AdapterContext,
  type Artifact,
  type ChunkOutput,
} from '@media-ingest/sdk';
import {
  withCredentialLock,
  subscriptionEnvironment,
  runSubscriptionProcess,
} from './subscription-runtime.js';

export interface CodexAudioOptions {
  codexHome: string;
  codexPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
}

export async function transcribeCodexAudio(
  artifact: Artifact,
  context: AdapterContext,
  options: CodexAudioOptions,
): Promise<ChunkOutput> {
  context = {
    ...context,
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)]),
  };
  if (!isAbsolute(artifact.uri) || !isAbsolute(options.codexHome))
    throw new MediaError(
      'subscription_configuration',
      'Codex audio requires absolute local media and dedicated credential home paths',
    );
  const workspace = await mkdtemp(join(tmpdir(), 'media-codex-audio-'));
  try {
    const env = subscriptionEnvironment('codex', options.codexHome, workspace);
    const codex = options.codexPath ?? 'codex';
    const probe = await runSubscriptionProcess(
      options.ffprobePath ?? 'ffprobe',
      [
        '-v',
        'error',
        ...mediaInputPolicy,
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        artifact.uri,
      ],
      { cwd: workspace, env, signal: context.signal, timeoutMs: 10_000 },
    );
    const durationMs = Math.ceil(Number(JSON.parse(probe.stdout).format?.duration) * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_000)
      throw new MediaError(
        'invalid_media',
        'Codex audio requires a clip between 1 and 60000 milliseconds',
      );
    // A cumulative digital peak of negative infinity means every decoded sample is exactly zero.
    // Quiet speech, including a single nonzero PCM sample, must still go through ASR.
    const stats = await runSubscriptionProcess(
      options.ffmpegPath ?? 'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        ...mediaInputPolicy,
        '-i',
        artifact.uri,
        '-map',
        '0:a:0',
        '-af',
        'astats=metadata=1:reset=0:measure_perchannel=none:measure_overall=Peak_level,ametadata=mode=print:key=lavfi.astats.Overall.Peak_level:file=-',
        '-f',
        'null',
        '-',
      ],
      { cwd: workspace, env, signal: context.signal, timeoutMs: 10_000 },
    );
    const peaks = [...stats.stdout.matchAll(/^lavfi\.astats\.Overall\.Peak_level=(.+)$/gm)];
    if (peaks.length && peaks.every((match) => match[1]?.trim() === '-inf'))
      return { text: '', segments: [], timeRanges: [], detectedLanguage: null };
    return await withCredentialLock(options.codexHome, context.signal, async () => {
      const version = await runSubscriptionProcess(codex, ['--version'], {
        cwd: workspace,
        env,
        signal: context.signal,
        timeoutMs: 10_000,
      });
      if (version.stdout.trim() !== 'codex-cli 0.163.0')
        throw new MediaError(
          'subscription_configuration',
          'Experimental audio requires codex-cli 0.163.0',
        );
      const output = await streamAudio(artifact, context, options, workspace, env, durationMs);
      return {
        ...output,
        provenance: { transcription: { provider: 'codex', protocol: 'realtime-v3', model: null } },
      };
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
