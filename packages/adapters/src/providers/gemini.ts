import { readFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { MediaRequest, ResolvedSource } from '@media-ingest/contracts';
import type {
  AdapterContext,
  Artifact,
  Chunk,
  ChunkOutput,
  MediaInputFormat,
  MediaInspection,
  RemoteMedia,
  SynthesisInput,
  SynthesisOutput,
} from '@media-ingest/sdk';
import { ApiProvider } from './api-provider.js';
import {
  checked,
  key,
  parseChunk,
  parseModelJson,
  parseSynthesis,
  parseTranslation,
  synthesisPrompt,
} from './shared.js';

interface GeminiFile {
  name: string;
  uri: string;
  mimeType: string;
  state?: string;
}
const geminiRoot = 'https://generativelanguage.googleapis.com';
const defaultTranscriptionModel = 'gemini-2.5-flash';
interface GeminiOptions {
  apiKey?: string;
  transcriptionModel?: string;
  understandingModel?: string;
  translationModel?: string;
  /** Read public YouTube videos by URL instead of uploading downloaded bytes. Default true. */
  youtubeUrls?: boolean;
  timeoutMs?: number;
}
const youtubeId = /^[\w-]{11}$/;

export class GeminiProvider extends ApiProvider {
  static readonly capabilities = {
    transcription: true,
    understanding: true,
    nativeVideo: true,
  } as const;

  static translator(options: GeminiOptions) {
    const model =
      options.translationModel ?? options.transcriptionModel ?? defaultTranscriptionModel;
    return async (prompt: string, signal: AbortSignal) =>
      parseTranslation(
        await generateGemini(
          model,
          key(options.apiKey, 'GEMINI_API_KEY'),
          [{ text: prompt }],
          signal,
        ),
      );
  }

  constructor(
    private readonly options: GeminiOptions = {},
    translator = GeminiProvider.translator(options),
  ) {
    super('google-gemini', options.timeoutMs, translator);
  }

  protected defaultModel(request: MediaRequest): string {
    return request.kind === 'understanding'
      ? (this.options.understandingModel ?? 'gemini-2.5-pro')
      : (this.options.transcriptionModel ?? defaultTranscriptionModel);
  }

  override inputFormat(_request: MediaRequest, inspection: MediaInspection): MediaInputFormat {
    return inspection.hasVideo ? 'video' : 'audio';
  }

  /** Native video stays available for transcription as well. */
  override sourceMedia(): 'audio' | 'video' {
    return 'video';
  }

  /**
   * Gemini fetches public YouTube videos itself, so no bytes are downloaded, re-encoded or
   * uploaded. Private, unlisted, age-restricted and live videos keep the download path.
   */
  remoteMedia(_request: MediaRequest, source: ResolvedSource): RemoteMedia | null {
    const { mediaId, durationMs, availability, ageLimit, live } = source.metadata;
    if (
      this.options.youtubeUrls === false ||
      source.source.kind !== 'youtube' ||
      typeof mediaId !== 'string' ||
      !youtubeId.test(mediaId) ||
      availability !== 'public' ||
      (ageLimit !== undefined && ageLimit !== 0) ||
      live !== false ||
      typeof durationMs !== 'number' ||
      !(durationMs > 0)
    )
      return null;
    return { uri: `https://www.youtube.com/watch?v=${mediaId}`, durationMs };
  }

  /** Clips the remote video to the chunk with offsets; billing covers only the clip. */
  async processRemote(
    media: RemoteMedia,
    chunk: Chunk,
    request: MediaRequest,
    context: AdapterContext,
  ): Promise<ChunkOutput> {
    const seconds = (ms: number) => `${ms / 1000}s`;
    const model = this.resolveModel(request);
    const apiKey = key(this.options.apiKey, 'GEMINI_API_KEY');
    const signal = this.signal(context);
    const clip = { startMs: chunk.startMs, endMs: chunk.endMs };
    return withinClip(clip, () =>
      generateGemini(
        model,
        apiKey,
        [
          { text: instructions(request, clip) },
          {
            file_data: { file_uri: media.uri },
            video_metadata: {
              start_offset: seconds(chunk.startMs),
              end_offset: seconds(chunk.endMs),
            },
          },
        ],
        signal,
      ),
    );
  }

  /** Text-only call with the understanding model over the span analyses. */
  async synthesize(
    input: SynthesisInput,
    request: MediaRequest,
    context: AdapterContext,
  ): Promise<SynthesisOutput> {
    const text = await generateGemini(
      this.resolveModel(request),
      key(this.options.apiKey, 'GEMINI_API_KEY'),
      [{ text: synthesisPrompt(input, request) }],
      this.signal(context),
    );
    return parseSynthesis(parseModelJson(text));
  }

  async process(
    artifact: Artifact,
    request: MediaRequest,
    context: AdapterContext,
  ): Promise<ChunkOutput> {
    const model = this.resolveModel(request);
    const signal = this.signal(context);
    const apiKey = key(this.options.apiKey, 'GEMINI_API_KEY');
    const size = (await stat(artifact.uri)).size;
    if (size > 1024 * 1024 * 1024) throw new Error('Gemini chunk exceeds 1 GiB');
    const mimeType =
      artifact.mimeType ?? (request.kind === 'understanding' ? 'video/mp4' : 'audio/mpeg');
    const start = await checked(`${geminiRoot}/upload/v1beta/files`, {
      method: 'POST',
      signal,
      headers: {
        'x-goog-api-key': apiKey,
        'x-goog-upload-protocol': 'resumable',
        'x-goog-upload-command': 'start',
        'x-goog-upload-header-content-length': String(size),
        'x-goog-upload-header-content-type': mimeType,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: artifact.fileName } }),
    });
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!uploadUrl || new URL(uploadUrl).origin !== geminiRoot)
      throw new Error('Invalid Gemini upload URL');
    const upload = await checked(uploadUrl, {
      method: 'POST',
      signal,
      headers: {
        'x-goog-upload-offset': '0',
        'x-goog-upload-command': 'upload, finalize',
        'content-type': mimeType,
      },
      body: await readFile(artifact.uri),
    });
    let file = ((await upload.json()) as { file: GeminiFile }).file;
    if (!file?.name || !/^files\/[\w-]+$/.test(file.name))
      throw new Error('Invalid Gemini file response');
    const name = file.name;
    try {
      while (file.state === 'PROCESSING') {
        await delay(1000, undefined, { signal });
        const response = await checked(`${geminiRoot}/v1beta/${name}`, {
          signal,
          headers: { 'x-goog-api-key': apiKey },
        });
        file = (await response.json()) as GeminiFile;
      }
      if (file.state !== 'ACTIVE' || !file.uri) throw new Error('Gemini media processing failed');
      const fileUri = file.uri;
      const clip = { startMs: 0, endMs: artifact.durationMs };
      return await withinClip(clip, () =>
        generateGemini(
          model,
          apiKey,
          [
            { text: instructions(request, clip) },
            { file_data: { mime_type: mimeType, file_uri: fileUri } },
          ],
          signal,
        ),
      );
    } finally {
      // Cleanup uses its own deadline so cancellation cannot leak uploaded files indefinitely.
      await fetch(`${geminiRoot}/v1beta/${name}`, {
        method: 'DELETE',
        redirect: 'error',
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }
  }
}

const clipAttempts = 3;

/** The span of the source video a call sees. Gemini labels frames on the source video's timeline. */
interface Clip {
  startMs: number;
  endMs: number | undefined;
}

/**
 * Gemini's timestamps are approximate, and some calls still drift outside the clip. Such output is
 * requested again, up to three calls in total; the worker rejects whatever remains.
 */
async function withinClip(clip: Clip, generate: () => Promise<string>): Promise<ChunkOutput> {
  for (let attempt = 1; ; attempt += 1) {
    const output = toClipTime(parseModelJson(await generate()), clip);
    if (output.inside || attempt >= clipAttempts) return parseChunk(output.value);
  }
}

/**
 * Converts video-timeline timestamps to milliseconds from the clip start. MM:SS has one-second
 * resolution, so a timestamp within one second outside an edge counts as that edge.
 */
export function toClipTime(value: unknown, clip: Clip): { value: unknown; inside: boolean } {
  if (!value || typeof value !== 'object') return { value, inside: true };
  const lengthMs = clip.endMs === undefined ? Infinity : clip.endMs - clip.startMs;
  let inside = true;
  const at = (raw: unknown) => {
    const ms = Math.round(seconds(raw) * 1000) - clip.startMs;
    if (ms < 0 && ms >= -1000) return 0;
    if (ms > lengthMs && ms <= lengthMs + 1000) return lengthMs;
    return ms;
  };
  const convert = (list: unknown) =>
    Array.isArray(list)
      ? list.map((item: unknown) => {
          if (!item || typeof item !== 'object') return item;
          const { start, end, ...rest } = item as Record<string, unknown>;
          const startMs = at(start);
          const endMs = at(end);
          if (!(startMs >= 0 && startMs <= endMs && endMs <= lengthMs)) inside = false;
          return { ...rest, startMs, endMs };
        })
      : list;
  const record = value as Record<string, unknown>;
  const converted = {
    ...record,
    segments: convert(record.segments),
    timeRanges: convert(record.timeRanges),
  };
  return { value: converted, inside };
}

/** Seconds from `H:MM:SS`, `MM:SS` or a plain number, each with optional fractions; NaN otherwise. */
function seconds(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(value.trim()))
    return Number.NaN;
  return value
    .trim()
    .split(':')
    .reduce((total, part) => total * 60 + Number(part), 0);
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const fraction = ms % 1000 ? `.${String(ms % 1000).padStart(3, '0')}` : '';
  const pad = (part: number) => String(part).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const rest = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}${fraction}`;
  return hours ? `${hours}:${rest}` : rest;
}

/**
 * Task and timing instructions for one clip. Gemini sees frames labelled on the source video's
 * timeline even when offsets clip it, so timestamps use that timeline and the code converts them.
 * Clip-relative milliseconds drifted past the clip in live runs; this format stayed within it.
 */
function instructions(request: MediaRequest, clip: Clip): string {
  const task =
    request.kind === 'transcription'
      ? `Transcribe in the source language. ${request.inputLanguage ? `Expected language: ${request.inputLanguage}.` : ''} Return JSON {"text":string,"detectedLanguage":string|null,"segments":[{"start":string,"end":string,"text":string,"speaker"?:string}]}. If segment timing is uncertain, return the full transcript with empty segments.`
      : `${request.prompt}\nReturn JSON {"text":string,"timeRanges":[{"start":string,"end":string,"label"?:string}]}. For a single still frame or uncertain timing, return the description with empty timeRanges.`;
  if (clip.endMs === undefined)
    return `${task}\nWrite timestamps as MM:SS (or MM:SS.mmm) on the video's own timeline. Never guess timestamps.`;
  const [from, to] = [clock(clip.startMs), clock(clip.endMs)];
  return `${task}\nYou are given only the part of the video from ${from} to ${to}. Describe only what is in this part. Write timestamps as MM:SS (or MM:SS.mmm) on the video's own timeline, as shown with the frames, so every interval satisfies ${from} <= start <= end <= ${to}. Never guess timestamps.`;
}

async function generateGemini(
  model: string,
  apiKey: string,
  parts: unknown[],
  signal: AbortSignal,
): Promise<string> {
  const response = await checked(
    `${geminiRoot}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      signal,
      headers: {
        'x-goog-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    },
  );
  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
  if (!text) throw new Error('Gemini returned no text');
  return text;
}
