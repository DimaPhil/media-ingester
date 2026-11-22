import { readFile, stat } from 'node:fs/promises';
import type { MediaRequest } from '@media-ingest/contracts';
import {
  MediaError,
  type AdapterContext,
  type Artifact,
  type ChunkOutput,
} from '@media-ingest/sdk';
import { z } from 'zod';
import { checked, conform, key, parseTranslation, readJson } from './shared.js';
import { ApiProvider } from './api-provider.js';

interface OpenAiOptions {
  apiKey?: string;
  model?: string;
  translationModel?: string;
  timeoutMs?: number;
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
export class OpenAiProvider extends ApiProvider {
  static readonly capabilities = {
    transcription: true,
    understanding: false,
    nativeVideo: false,
  } as const;

  static translator({ apiKey, translationModel = 'gpt-4.1-mini' }: OpenAiOptions) {
    return (prompt: string, signal: AbortSignal) =>
      translateOpenAi(prompt, translationModel, apiKey, signal);
  }

  constructor(
    private readonly options: OpenAiOptions = {},
    translator = OpenAiProvider.translator(options),
  ) {
    super('openai', options.timeoutMs, translator);
  }

  protected defaultModel(): string {
    return this.options.model ?? 'gpt-4o-transcribe';
  }

  async process(
    artifact: Artifact,
    request: MediaRequest,
    context: AdapterContext,
  ): Promise<ChunkOutput> {
    if (request.kind !== 'transcription')
      throw new MediaError('invalid_request', 'Understanding requires Gemini');
    const model = this.resolveModel(request);
    const apiKey = key(this.options.apiKey, 'OPENAI_API_KEY');
    if ((await stat(artifact.uri)).size > 24 * 1024 * 1024)
      throw new MediaError('media_too_large', 'OpenAI chunk exceeds 24 MiB', false, {
        provider: 'openai',
      });
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
    return this.withDeadline(context, async (signal) => {
      const response = await checked(
        'https://api.openai.com/v1/audio/transcriptions',
        { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal },
        'openai',
      );
      return conform(await readJson(response, 'openai', signal), parseOpenAi, 'openai', { model });
    });
  }
}
async function translateOpenAi(
  prompt: string,
  model: string,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const token = key(apiKey, 'Translation provider');
  const response = await checked(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    },
    'openai',
  );
  const data = (await readJson(response, 'openai', signal)) as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
  };
  const choice = data.choices?.[0];
  const details = { provider: 'openai', model };
  if (choice?.finish_reason === 'length')
    throw new MediaError(
      'provider_output_truncated',
      'OpenAI reached its output token limit before finishing the translation',
      false,
      { ...details, finishReason: 'length' },
    );
  if (choice?.finish_reason === 'content_filter')
    throw new MediaError('provider_blocked', 'OpenAI filtered the translation', false, {
      ...details,
      finishReason: 'content_filter',
    });
  return parseTranslation(choice?.message?.content ?? '', 'openai');
}
