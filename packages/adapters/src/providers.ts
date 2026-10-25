import { readFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { rangeSchema, segmentSchema, type MediaRequest } from '@media-ingest/contracts';
import type {
  AdapterContext,
  Artifact,
  ChunkOutput,
  MediaInputFormat,
  MediaInspection,
  ProviderAdapter,
} from '@media-ingest/sdk';
import { MediaError } from '@media-ingest/sdk';
import { googleAccessToken } from './sources.js';
import { transcribeCodexAudio } from './codex-audio.js';
import { understandSubscription, translateSubscription } from './subscription-understanding.js';

export interface NodeProviderOptions {
  openaiApiKey?: string;
  geminiApiKey?: string;
  googleCredentials?: Record<string, unknown>;
  googleProject?: string;
  googleRecognizer?: string;
  subscription?: {
    codexHome: string;
    claudeHome?: string;
    codexPath?: string;
    claudePath?: string;
    ffmpegPath?: string;
    ffprobePath?: string;
    timeoutMs?: number;
  };
  models?: {
    openai?: string;
    geminiTranscription?: string;
    geminiUnderstanding?: string;
    googleSpeech?: string;
    translation?: string;
    codexUnderstanding?: string;
    claudeUnderstanding?: string;
  };
  timeoutMs?: number;
}
const chunkSchema = z.object({
  text: z.string(),
  segments: z.array(segmentSchema).default([]),
  timeRanges: z.array(rangeSchema).default([]),
  detectedLanguage: z.string().nullable().default(null),
});
export function parseChunk(value: unknown): ChunkOutput {
  return chunkSchema.parse(value);
}
export function parseModelJson(text: string): unknown {
  return JSON.parse(
    text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, ''),
  );
}
const openAiSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
  segments: z
    .array(
      z.object({
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
        text: z.string(),
        speaker: z.string().optional(),
      }),
    )
    .optional(),
});
export function parseOpenAi(value: unknown): ChunkOutput {
  const data = openAiSchema.parse(value);
  return {
    text: data.text,
    detectedLanguage: data.language ?? null,
    timeRanges: [],
    segments: (data.segments ?? []).map((segment) => ({
      startMs: Math.round(segment.start * 1000),
      endMs: Math.round(segment.end * 1000),
      text: segment.text,
      ...(segment.speaker ? { speaker: segment.speaker } : {}),
    })),
  };
}
async function checked(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'error' });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  return response;
}
function key(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
interface GeminiFile {
  name: string;
  uri: string;
  mimeType: string;
  state?: string;
}
const geminiRoot = 'https://generativelanguage.googleapis.com';
/** Transport capabilities of the built-in adapters, independent of an individual model default. */
export const BUILTIN_PROVIDER_CAPABILITIES = {
  openai: { transcription: true, understanding: false, nativeVideo: false },
  'google-gemini': { transcription: true, understanding: true, nativeVideo: true },
  'google-speech': { transcription: true, understanding: false, nativeVideo: false },
  codex: { transcription: true, understanding: true, nativeVideo: false },
  'claude-code': { transcription: false, understanding: true, nativeVideo: false },
} as const;
export class NodeProviders implements ProviderAdapter {
  constructor(private readonly options: NodeProviderOptions = {}) {}
  resolveModel(request: MediaRequest): string {
    if (request.provider === 'codex' && request.kind === 'transcription') {
      if (request.model && request.model !== 'codex-realtime-v3')
        throw new MediaError(
          'invalid_request',
          'Codex transcription uses the codex-realtime-v3 protocol; its ASR model is service-selected',
        );
      return 'codex-realtime-v3';
    }
    if (request.model) return request.model;
    if (request.provider === 'codex')
      return this.options.models?.codexUnderstanding ?? 'gpt-6.1-sol';
    if (request.provider === 'claude-code')
      return this.options.models?.claudeUnderstanding ?? 'sonnet';
    if (request.provider === 'openai') return this.options.models?.openai ?? 'gpt-4o-transcribe';
    if (request.provider === 'google-speech') return this.options.models?.googleSpeech ?? 'chirp_3';
    return request.kind === 'understanding'
      ? (this.options.models?.geminiUnderstanding ?? 'gemini-2.5-pro')
      : (this.options.models?.geminiTranscription ?? 'gemini-2.5-flash');
  }
  chunkDurationMs(request: MediaRequest): number {
    if (request.provider === 'codex' || request.provider === 'claude-code') return 60_000;
    return request.provider === 'google-speech' ? 55_000 : 10 * 60_000;
  }
  inputFormat(request: MediaRequest, inspection: MediaInspection): MediaInputFormat {
    if (request.provider === 'codex' && request.kind === 'transcription') return 'audio_pcm';
    if (
      (request.provider === 'codex' || request.provider === 'claude-code') &&
      request.kind === 'understanding'
    )
      return inspection.hasVideo ? 'video' : 'audio_pcm';
    return BUILTIN_PROVIDER_CAPABILITIES[request.provider].nativeVideo && inspection.hasVideo
      ? 'video'
      : 'audio';
  }
  private signal(context: AdapterContext): AbortSignal {
    return AbortSignal.any([
      context.signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 10 * 60_000),
    ]);
  }
  async process(
    artifact: Artifact,
    request: MediaRequest,
    context: AdapterContext,
  ): Promise<ChunkOutput> {
    if (request.provider === 'codex' || request.provider === 'claude-code') {
      const options = this.subscriptionOptions();
      if (request.kind === 'transcription') {
        this.resolveModel(request);
        return {
          ...(await transcribeCodexAudio(artifact, context, options)),
          provenance: {
            transcription: { provider: 'codex', protocol: 'realtime-v3', model: null },
          },
        };
      }
      return understandSubscription(artifact, request, context, options);
    }
    const signal = this.signal(context);
    if (request.kind === 'understanding' && request.provider !== 'google-gemini')
      throw new Error('Understanding requires Gemini');
    if (request.provider === 'google-gemini') return this.gemini(artifact, request, signal);
    if (request.provider === 'google-speech') return this.speech(artifact, request, signal);
    if ((await stat(artifact.uri)).size > 24 * 1024 * 1024)
      throw new Error('OpenAI chunk exceeds 24 MiB');
    const model = this.resolveModel(request);
    const form = new FormData();
    form.set(
      'file',
      new Blob([await readFile(artifact.uri)], { type: artifact.mimeType ?? 'audio/mpeg' }),
      artifact.fileName,
    );
    form.set('model', model);
    form.set(
      'response_format',
      model.includes('diarize')
        ? 'diarized_json'
        : model.startsWith('whisper-')
          ? 'verbose_json'
          : 'json',
    );
    if (model.includes('diarize')) form.set('chunking_strategy', 'auto');
    if (request.inputLanguage) form.set('language', request.inputLanguage);
    const response = await checked('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key(this.options.openaiApiKey, 'OPENAI_API_KEY')}` },
      body: form,
      signal,
    });
    return parseOpenAi(await response.json());
  }
  private subscriptionOptions() {
    if (!this.options.subscription?.codexHome)
      throw new MediaError(
        'subscription_configuration',
        'MEDIA_CODEX_HOME must point to a dedicated authenticated credential directory',
      );
    return this.options.subscription;
  }
  private async gemini(
    artifact: Artifact,
    request: MediaRequest,
    signal: AbortSignal,
  ): Promise<ChunkOutput> {
    const apiKey = key(this.options.geminiApiKey, 'GEMINI_API_KEY');
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
      const prompt =
        request.kind === 'transcription'
          ? `Transcribe in the source language. ${request.inputLanguage ? `Expected language: ${request.inputLanguage}.` : ''} Return JSON {"text":string,"detectedLanguage":string|null,"segments":[{"startMs":number,"endMs":number,"text":string,"speaker"?:string}]}. Times are relative to this clip.`
          : `${request.prompt}\nReturn JSON {"text":string,"timeRanges":[{"startMs":number,"endMs":number,"label"?:string}]}. Times are relative to this clip.`;
      return parseChunk(
        parseModelJson(
          await this.generateGemini(
            this.resolveModel(request),
            [{ text: prompt }, { file_data: { mime_type: mimeType, file_uri: file.uri } }],
            signal,
          ),
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
  private async generateGemini(
    model: string,
    parts: unknown[],
    signal: AbortSignal,
  ): Promise<string> {
    const response = await checked(
      `${geminiRoot}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        signal,
        headers: {
          'x-goog-api-key': key(this.options.geminiApiKey, 'GEMINI_API_KEY'),
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
  private async speech(
    artifact: Artifact,
    request: MediaRequest,
    signal: AbortSignal,
  ): Promise<ChunkOutput> {
    if ((await stat(artifact.uri)).size > 10 * 1024 * 1024)
      throw new Error('Google Speech synchronous chunk exceeds 10 MiB');
    const recognizer =
      this.options.googleRecognizer ??
      `projects/${key(this.options.googleProject, 'GOOGLE_CLOUD_PROJECT')}/locations/global/recognizers/_`;
    if (!/^projects\/[\w-]+\/locations\/[\w-]+\/recognizers\/[\w-]+$/.test(recognizer))
      throw new Error('Invalid Google Speech recognizer');
    const location = recognizer.split('/')[3]!;
    const host =
      location === 'global' ? 'speech.googleapis.com' : `${location}-speech.googleapis.com`;
    const token = await googleAccessToken(this.options.googleCredentials);
    const response = await checked(`https://${host}/v2/${recognizer}:recognize`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          autoDecodingConfig: {},
          languageCodes: [request.inputLanguage ?? 'auto'],
          model: this.resolveModel(request),
          features: { enableWordTimeOffsets: true },
        },
        content: (await readFile(artifact.uri)).toString('base64'),
      }),
    });
    const payload = (await response.json()) as {
      results?: Array<{
        languageCode?: string;
        alternatives?: Array<{
          transcript?: string;
          words?: Array<{
            startOffset?: string;
            endOffset?: string;
            word?: string;
            speakerLabel?: string;
          }>;
        }>;
      }>;
    };
    const results = payload.results ?? [];
    const segments = results.flatMap((result) => {
      const alternative = result.alternatives?.[0];
      if (!alternative?.transcript) return [];
      const words = alternative.words ?? [];
      return [
        {
          startMs: Math.round(parseFloat(words[0]?.startOffset ?? '0') * 1000),
          endMs: Math.round(parseFloat(words.at(-1)?.endOffset ?? '0') * 1000),
          text: alternative.transcript,
        },
      ];
    });
    return parseChunk({
      text: segments.map((segment) => segment.text).join(' '),
      segments,
      detectedLanguage: results.find((result) => result.languageCode)?.languageCode ?? null,
    });
  }
  async translate(text: string, request: MediaRequest, context: AdapterContext): Promise<string> {
    if (!request.targetLanguage) return text;
    if (request.provider === 'codex' || request.provider === 'claude-code')
      return translateSubscription(
        text,
        {
          ...request,
          model:
            request.kind === 'transcription'
              ? (this.options.models?.codexUnderstanding ?? 'gpt-6.1-sol')
              : this.resolveModel(request),
        },
        context,
        this.subscriptionOptions(),
      );
    const prompt = `Translate accurately to ${request.targetLanguage}, preserving speaker markers. Return JSON {"translatedText":string}.\n\n${text}`;
    if (this.options.geminiApiKey) {
      const result = parseModelJson(
        await this.generateGemini(
          this.options.models?.translation ??
            this.options.models?.geminiTranscription ??
            'gemini-2.5-flash',
          [{ text: prompt }],
          this.signal(context),
        ),
      );
      return z.object({ translatedText: z.string() }).parse(result).translatedText;
    }
    const response = await checked('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: this.signal(context),
      headers: {
        Authorization: `Bearer ${key(this.options.openaiApiKey, 'Translation provider')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.models?.translation ?? 'gpt-4.1-mini',
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return z
      .object({ translatedText: z.string() })
      .parse(parseModelJson(data.choices?.[0]?.message?.content ?? '')).translatedText;
  }
}
