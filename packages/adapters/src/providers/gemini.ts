import { readFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { ErrorDetails, MediaRequest, ResolvedSource } from '@media-ingest/contracts';
import {
  MediaError,
  type AdapterContext,
  type Artifact,
  type Chunk,
  type ChunkOutput,
  type MediaInputFormat,
  type MediaInspection,
  type RemoteMedia,
  type SynthesisInput,
  type SynthesisOutput,
} from '@media-ingest/sdk';
import { ApiProvider } from './api-provider.js';
import {
  checked,
  conform,
  decodeModelJson,
  invalidOutput,
  key,
  parseChunk,
  parseSynthesis,
  readJson,
  synthesisPrompt,
} from './shared.js';

interface GeminiFile {
  name: string;
  uri: string;
  mimeType: string;
  state?: string;
}
const geminiRoot = 'https://generativelanguage.googleapis.com';
const provider = 'google-gemini';
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
    return async (prompt: string, signal: AbortSignal) => {
      const apiKey = key(options.apiKey, 'GEMINI_API_KEY');
      const output = await generateJson(
        () =>
          generateGemini(model, apiKey, [{ text: prompt }], signal, {
            schema: schemas.translation,
            maxOutputTokens: translationOutputTokens(prompt),
          }),
        (value, details) => ({
          value: conform(value, (raw) => translationSchema.parse(raw), provider, details),
          retry: false,
        }),
      );
      return output.translatedText;
    };
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
    const clip = { startMs: chunk.startMs, endMs: chunk.endMs };
    return this.withDeadline(context, (signal) =>
      withinClip(clip, () =>
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
          chunkOutput(request, chunk.endMs - chunk.startMs),
        ),
      ),
    );
  }

  /** Text-only call with the understanding model over the span analyses. */
  async synthesize(
    input: SynthesisInput,
    request: MediaRequest,
    context: AdapterContext,
  ): Promise<SynthesisOutput> {
    const model = this.resolveModel(request);
    const apiKey = key(this.options.apiKey, 'GEMINI_API_KEY');
    return this.withDeadline(context, (signal) =>
      generateJson(
        () =>
          generateGemini(
            model,
            apiKey,
            [{ text: synthesisPrompt(input, request) }],
            signal,
            // The whole-media answer has no size bound to derive; the model's own limit applies.
            { schema: schemas.synthesis },
          ),
        (value, details) => ({
          value: conform(value, parseSynthesis, provider, details),
          retry: false,
        }),
      ),
    );
  }

  async process(
    artifact: Artifact,
    request: MediaRequest,
    context: AdapterContext,
  ): Promise<ChunkOutput> {
    const model = this.resolveModel(request);
    const apiKey = key(this.options.apiKey, 'GEMINI_API_KEY');
    return this.withDeadline(context, (signal) =>
      this.processUpload(artifact, request, model, apiKey, signal),
    );
  }

  private async processUpload(
    artifact: Artifact,
    request: MediaRequest,
    model: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<ChunkOutput> {
    const size = (await stat(artifact.uri)).size;
    if (size > 1024 * 1024 * 1024)
      throw new MediaError('media_too_large', 'Gemini chunk exceeds 1 GiB', false, { provider });
    const mimeType =
      artifact.mimeType ?? (request.kind === 'understanding' ? 'video/mp4' : 'audio/mpeg');
    const start = await checked(
      `${geminiRoot}/upload/v1beta/files`,
      {
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
      },
      provider,
    );
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!uploadUrl || URL.parse(uploadUrl)?.origin !== geminiRoot)
      throw invalidOutput(provider, 'invalid upload URL');
    const upload = await checked(
      uploadUrl,
      {
        method: 'POST',
        signal,
        headers: {
          'x-goog-upload-offset': '0',
          'x-goog-upload-command': 'upload, finalize',
          'content-type': mimeType,
        },
        body: await readFile(artifact.uri),
      },
      provider,
    );
    let file = ((await readJson(upload, provider, signal)) as { file?: GeminiFile } | null)?.file;
    if (!file?.name || !/^files\/[\w-]+$/.test(file.name))
      throw invalidOutput(provider, 'invalid file upload response');
    const name = file.name;
    try {
      while (file.state === 'PROCESSING') {
        await delay(1000, undefined, { signal });
        const response = await checked(
          `${geminiRoot}/v1beta/${name}`,
          { signal, headers: { 'x-goog-api-key': apiKey } },
          provider,
        );
        file = ((await readJson(response, provider, signal)) ?? {}) as GeminiFile;
      }
      if (file.state !== 'ACTIVE' || !file.uri) {
        const state = /^[A-Z_]{1,40}$/.test(file.state ?? '') ? file.state! : 'UNKNOWN';
        throw new MediaError(
          'provider_rejected',
          `Gemini media processing failed (file state ${state})`,
          false,
          { provider, model, fileState: state },
        );
      }
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
          chunkOutput(request, artifact.durationMs),
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

/** Calls per chunk, synthesis or translation, shared by unusable output and drifting timestamps. */
const generationAttempts = 3;

/** The span of the source video a call sees. Gemini labels frames on the source video's timeline. */
interface Clip {
  startMs: number;
  endMs: number | undefined;
}

/**
 * Gemini's timestamps are approximate, and some calls still drift outside the clip. Such output is
 * requested again within the shared call budget; the worker rejects whatever remains. A truncated
 * chunk answer is usually a repetition loop that does not recur, so it is requested again too.
 */
function withinClip(clip: Clip, generate: () => Promise<GeminiReply>): Promise<ChunkOutput> {
  return generateJson(
    generate,
    (value, details) => {
      const output = toClipTime(value, clip);
      return { value: conform(output.value, parseChunk, provider, details), retry: !output.inside };
    },
    chunkRetries,
  );
}

const outputRetries: ReadonlySet<string> = new Set(['provider_invalid_output']);
const chunkRetries: ReadonlySet<string> = new Set([
  'provider_invalid_output',
  'provider_output_truncated',
]);

/**
 * Requests JSON until `accept` takes it, at most three calls. Failures with a code in `retryOn`
 * (by default unusable output: invalid JSON, missing fields, empty text) are asked for again and
 * the last one is raised with the number of calls; blocked and HTTP failures are not.
 */
export async function generateJson<T>(
  generate: () => Promise<GeminiReply>,
  accept: (value: unknown, details: ErrorDetails) => { value: T; retry: boolean },
  retryOn = outputRetries,
): Promise<T> {
  for (let call = 1; ; call += 1) {
    let accepted: { value: T; retry: boolean };
    try {
      const reply = await generate();
      const details = { ...reply.details, calls: call };
      accepted = accept(decodeModelJson(reply.text, provider, details), details);
    } catch (error) {
      if (!(error instanceof MediaError) || !retryOn.has(error.code)) throw error;
      if (call < generationAttempts) continue;
      throw new MediaError(error.code, error.message, error.retryable, {
        ...error.details,
        calls: call,
      });
    }
    if (!accepted.retry || call >= generationAttempts) return accepted.value;
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

type JsonSchema = Record<string, unknown>;
const text = { type: 'string' };
const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const clipRange = (labelled: boolean) =>
  object({ start: text, end: text, ...(labelled ? { label: text } : { speaker: text }) }, [
    'start',
    'end',
  ]);
/**
 * Response shapes for constrained decoding (`responseJsonSchema`). Gemini then emits valid JSON,
 * escaping quotes inside strings. Timestamps stay strings in the format the prompt asks for.
 */
const schemas = {
  transcription: object({
    text,
    detectedLanguage: { type: ['string', 'null'] },
    segments: {
      type: 'array',
      items: object({ start: text, end: text, text, speaker: text }, ['start', 'end', 'text']),
    },
  }),
  understanding: object({ text, timeRanges: { type: 'array', items: clipRange(true) } }),
  synthesis: object({
    text,
    timeRanges: {
      type: 'array',
      items: object({
        startMs: { type: 'number' },
        endMs: { type: 'number' },
        label: { type: ['string', 'null'] },
      }),
    },
  }),
  translation: object({ translatedText: text }),
} satisfies Record<string, JsonSchema>;
const translationSchema = z.object({ translatedText: z.string() });
/**
 * Output caps so a degenerate repetition loop fails in seconds instead of running to the model's
 * 65,536-token limit. In the live 3 h Russian transcription, 10-minute chunks needed 5,000–7,000
 * output tokens (at most about 12 per second of media), while one looping chunk ran to 65,352.
 * 36 tokens per second is three times that peak; verbatim speech is the densest regular output,
 * so understanding answers use the same rate. Gemini 2.5 counts thinking tokens against
 * `maxOutputTokens`, so each cap adds a thinking allowance, larger for understanding, whose
 * default model is 2.5 Pro. That allowance is also the floor for very short chunks. The ceiling
 * is the 65,536-token output limit of Gemini 2.5 Flash and Pro. A 10-minute chunk gets 29,792
 * tokens for transcription and 37,984 for understanding.
 */
const chunkOutputTokensPerSecond = 36;
const thinkingAllowance = { transcription: 8_192, understanding: 16_384 } as const;
const outputTokenLimit = 65_536;
/** The provider's chunk length, assumed when a chunk's duration is unknown. */
const defaultChunkMs = 10 * 60_000;

export function chunkOutputTokens(request: MediaRequest, durationMs: number | undefined): number {
  const seconds = (durationMs && durationMs > 0 ? durationMs : defaultChunkMs) / 1000;
  return Math.min(
    outputTokenLimit,
    thinkingAllowance[request.kind] + Math.ceil(seconds * chunkOutputTokensPerSecond),
  );
}

/**
 * Translation output is about as long as its input. Latin and Cyrillic text average three to four
 * characters per token, so one token per two prompt characters leaves 1.5–2× headroom; the
 * transcription thinking allowance comes on top.
 */
export function translationOutputTokens(prompt: string): number {
  return Math.min(outputTokenLimit, thinkingAllowance.transcription + Math.ceil(prompt.length / 2));
}

function chunkOutput(request: MediaRequest, durationMs: number | undefined): GeminiOutput {
  return {
    schema: request.kind === 'transcription' ? schemas.transcription : schemas.understanding,
    maxOutputTokens: chunkOutputTokens(request, durationMs),
  };
}

/** Response schema and optional output cap for one call. */
interface GeminiOutput {
  schema: JsonSchema;
  maxOutputTokens?: number;
}

/** Response text plus the diagnostics recorded with any failure it causes. */
export interface GeminiReply {
  text: string;
  details: ErrorDetails;
}
interface GeminiResponse {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}
/** Finish reasons that mean Gemini refused the content; asking again returns the same. */
const blockedFinishReasons = new Set([
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
]);
const enumValue = (value: unknown) =>
  typeof value === 'string' && /^[A-Z_]{1,40}$/.test(value) ? value : undefined;

/**
 * Extracts the response text, or raises a specific error for a blocked prompt, a refused or
 * truncated candidate, or an empty answer. Records finish reason and token usage, never content.
 */
export function geminiReply(
  data: GeminiResponse,
  model: string,
  maxOutputTokens?: number,
): GeminiReply {
  const usage = data.usageMetadata;
  const finishReason = enumValue(data.candidates?.[0]?.finishReason);
  const details: ErrorDetails = {
    provider,
    model,
    ...(finishReason ? { finishReason } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(typeof usage?.promptTokenCount === 'number'
      ? { promptTokens: usage.promptTokenCount }
      : {}),
    ...(typeof usage?.candidatesTokenCount === 'number'
      ? { outputTokens: usage.candidatesTokenCount }
      : {}),
    ...(typeof usage?.thoughtsTokenCount === 'number'
      ? { thoughtsTokens: usage.thoughtsTokenCount }
      : {}),
  };
  const blockReason =
    data.promptFeedback?.blockReason && enumValue(data.promptFeedback.blockReason);
  if (data.promptFeedback?.blockReason)
    throw new MediaError(
      'provider_blocked',
      `Gemini blocked the request (${blockReason ?? 'OTHER'})`,
      false,
      { ...details, blockReason: blockReason ?? 'OTHER' },
    );
  // Usually a repetition loop: the same request then succeeds, as a production retry showed.
  if (finishReason === 'MAX_TOKENS')
    throw new MediaError(
      'provider_output_truncated',
      'Gemini reached its output token limit before finishing the answer',
      true,
      details,
    );
  if (finishReason && blockedFinishReasons.has(finishReason))
    throw new MediaError(
      'provider_blocked',
      `Gemini stopped the answer (${finishReason})`,
      false,
      details,
    );
  const answer = (data.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('');
  if (!answer.trim()) throw invalidOutput(provider, 'empty response', details);
  return { text: answer, details };
}

async function generateGemini(
  model: string,
  apiKey: string,
  parts: unknown[],
  signal: AbortSignal,
  output: GeminiOutput,
): Promise<GeminiReply> {
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
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: output.schema,
          ...(output.maxOutputTokens ? { maxOutputTokens: output.maxOutputTokens } : {}),
        },
      }),
    },
    provider,
  );
  return geminiReply(
    (await readJson(response, provider, signal)) as GeminiResponse,
    model,
    output.maxOutputTokens,
  );
}
