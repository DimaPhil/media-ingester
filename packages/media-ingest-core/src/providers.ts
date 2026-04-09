import { readFile } from 'node:fs/promises';

import { SpeechClient } from '@google-cloud/speech';
import OpenAI from 'openai';

import type { AppConfig } from './config';
import type { MediaSegment, ProviderId, TimeRange } from './types';
import type { ProviderCapability } from './media';

interface TranscriptionChunkResult {
  text: string;
  detectedLanguage: string | null;
  segments: MediaSegment[];
  raw?: unknown;
}

interface UnderstandingChunkResult {
  responseText: string;
  timeRanges?: TimeRange[];
  raw?: unknown;
}

interface OpenAiTranscriptionPayload {
  text?: string;
  language?: string;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
    speaker?: string;
  }>;
}

export interface OpenAiTranscriptionRequestOptions {
  response_format: 'json' | 'verbose_json' | 'diarized_json';
  timestamp_granularities?: ['segment'];
}

export interface TranscriptionProvider {
  readonly id: ProviderId;
  resolveModel(model?: string): string;
  capability(model?: string): ProviderCapability;
  transcribeChunk(input: {
    filePath: string;
    model?: string;
    inputLanguage?: string;
  }): Promise<TranscriptionChunkResult>;
  translateText?(input: {
    model?: string;
    text: string;
    targetLanguage: string;
  }): Promise<string>;
}

export interface UnderstandingProvider {
  readonly id: ProviderId;
  resolveModel(model?: string): string;
  capability(model?: string): ProviderCapability;
  understandChunk(input: {
    filePath: string;
    model?: string;
    prompt: string;
  }): Promise<UnderstandingChunkResult>;
}

function stripCodeFence(value: string): string {
  return value.replace(/^```(?:json)?/u, '').replace(/```$/u, '').trim();
}

function parseJsonObject<T>(value: string): T {
  return JSON.parse(stripCodeFence(value)) as T;
}

function providerCapabilityFor(kind: ProviderId): ProviderCapability {
  switch (kind) {
    case 'openai':
      return {
        maxWholeFileDurationMs: 12 * 60 * 1000,
        chunkDurationMs: 12 * 60 * 1000,
        overlapMs: 2_000,
      };
    case 'google-speech':
      return {
        maxWholeFileDurationMs: 25 * 60 * 1000,
        chunkDurationMs: 20 * 60 * 1000,
        overlapMs: 2_000,
      };
    case 'google-gemini':
      return {
        maxWholeFileDurationMs: 20 * 60 * 1000,
        chunkDurationMs: 10 * 60 * 1000,
        overlapMs: 2_000,
      };
    default:
      return {
        maxWholeFileDurationMs: 10 * 60 * 1000,
        chunkDurationMs: 10 * 60 * 1000,
        overlapMs: 2_000,
      };
  }
}

export function buildOpenAiTranscriptionRequestOptions(
  model: string,
): OpenAiTranscriptionRequestOptions {
  if (model.includes('transcribe-diarize')) {
    return {
      response_format: 'diarized_json',
    };
  }

  if (model.startsWith('whisper-')) {
    return {
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    };
  }

  return {
    response_format: 'json',
  };
}

export function normalizeOpenAiTranscriptionPayload(
  payload: OpenAiTranscriptionPayload,
): TranscriptionChunkResult {
  return {
    text: payload.text ?? '',
    detectedLanguage: payload.language ?? null,
    segments:
      payload.segments?.map((segment) => ({
        startMs: Math.round((segment.start ?? 0) * 1000),
        endMs: Math.round((segment.end ?? 0) * 1000),
        text: segment.text ?? '',
        ...(segment.speaker ? { speaker: segment.speaker } : {}),
      })) ?? [],
    raw: payload,
  };
}

class OpenAiProvider implements TranscriptionProvider {
  public readonly id = 'openai' as const;
  private readonly client: OpenAI;

  public constructor(private readonly config: AppConfig) {
    this.client = new OpenAI({
      apiKey: config.providers.openai.apiKey || undefined,
      baseURL: config.providers.openai.baseUrl,
    });
  }

  public resolveModel(model?: string): string {
    return model ?? this.config.providers.openai.defaultModel;
  }

  public capability(): ProviderCapability {
    return providerCapabilityFor(this.id);
  }

  public async transcribeChunk(input: {
    filePath: string;
    model?: string;
    inputLanguage?: string;
  }): Promise<TranscriptionChunkResult> {
    const model = this.resolveModel(input.model);
    const response = await this.client.audio.transcriptions.create(
      {
        file: await OpenAI.toFile(await readFile(input.filePath), input.filePath),
        model,
        ...(input.inputLanguage ? { language: input.inputLanguage } : {}),
        ...buildOpenAiTranscriptionRequestOptions(model),
      } as never,
    );
    return normalizeOpenAiTranscriptionPayload(response as OpenAiTranscriptionPayload);
  }

  public async translateText(input: {
    model?: string;
    text: string;
    targetLanguage: string;
  }): Promise<string> {
    const response = await this.client.responses.create({
      model: input.model ?? this.config.providers.openai.translationModel,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: 'Translate the given transcript accurately and preserve speaker markers when present.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Target language: ${input.targetLanguage}\n\nTranscript:\n${input.text}`,
            },
          ],
        },
      ],
    });
    return response.output_text ?? '';
  }
}

class GoogleGeminiProvider implements TranscriptionProvider, UnderstandingProvider {
  public readonly id = 'google-gemini' as const;

  public constructor(private readonly config: AppConfig) {}

  public resolveModel(model?: string): string {
    return model ?? this.config.providers.gemini.geminiTranscriptionModel;
  }

  public resolveUnderstandingModel(model?: string): string {
    return model ?? this.config.providers.gemini.geminiUnderstandingModel;
  }

  public capability(): ProviderCapability {
    return providerCapabilityFor(this.id);
  }

  private async callGemini<T>(input: {
    model: string;
    prompt: string;
    filePath?: string;
    mimeType?: string;
  }): Promise<T> {
    const parts: Array<Record<string, unknown>> = [{ text: input.prompt }];
    if (input.filePath && input.mimeType) {
      parts.push({
        inline_data: {
          mime_type: input.mimeType,
          data: (await readFile(input.filePath)).toString('base64'),
        },
      });
    }
    const body = {
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
      },
    };
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent?key=${this.config.providers.gemini.apiKey}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new Error(`Gemini request failed with status ${response.status}`);
    }
    const payload = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('\n') ?? '';
    return parseJsonObject<T>(text);
  }

  public async transcribeChunk(input: {
    filePath: string;
    model?: string;
    inputLanguage?: string;
  }): Promise<TranscriptionChunkResult> {
    const payload = await this.callGemini<{
      text: string;
      detectedLanguage?: string;
      segments?: Array<{
        startMs: number;
        endMs: number;
        text: string;
        speaker?: string;
      }>;
    }>({
      model: this.resolveModel(input.model),
      prompt: [
        'Transcribe the media in the source language.',
        input.inputLanguage ? `The expected language is ${input.inputLanguage}.` : 'Auto-detect the language.',
        'Return strict JSON: {"text": string, "detectedLanguage": string|null, "segments": [{"startMs": number, "endMs": number, "text": string, "speaker"?: string}]}.',
      ].join(' '),
      filePath: input.filePath,
      mimeType: 'audio/mpeg',
    });
    return {
      text: payload.text,
      detectedLanguage: payload.detectedLanguage ?? null,
      segments: payload.segments ?? [],
      raw: payload,
    };
  }

  public async understandChunk(input: {
    filePath: string;
    model?: string;
    prompt: string;
  }): Promise<UnderstandingChunkResult> {
    const payload = await this.callGemini<{
      responseText: string;
      timeRanges?: Array<{ startMs: number; endMs: number; label?: string }>;
    }>({
      model: this.resolveUnderstandingModel(input.model),
      prompt: `${input.prompt}\nReturn strict JSON: {"responseText": string, "timeRanges": [{"startMs": number, "endMs": number, "label"?: string}]}.`,
      filePath: input.filePath,
      mimeType: 'video/mp4',
    });
    return {
      responseText: payload.responseText,
      timeRanges: payload.timeRanges,
      raw: payload,
    };
  }

  public async translateText(input: {
    model?: string;
    text: string;
    targetLanguage: string;
  }): Promise<string> {
    const payload = await this.callGemini<{ translatedText: string }>({
      model: this.resolveUnderstandingModel(input.model),
      prompt: `Translate the following transcript to ${input.targetLanguage}. Return strict JSON: {"translatedText": string}.\n\n${input.text}`,
    });
    return payload.translatedText;
  }
}

class GoogleSpeechProvider implements TranscriptionProvider {
  public readonly id = 'google-speech' as const;
  private readonly client: SpeechClient;

  public constructor(private readonly config: AppConfig) {
    this.client = new SpeechClient({
      ...(config.providers.googleCloud.serviceAccountJson
        ? { credentials: JSON.parse(config.providers.googleCloud.serviceAccountJson) }
        : {}),
      ...(config.providers.googleCloud.projectId
        ? { projectId: config.providers.googleCloud.projectId }
        : {}),
    });
  }

  public resolveModel(model?: string): string {
    return model ?? 'chirp_3';
  }

  public capability(): ProviderCapability {
    return providerCapabilityFor(this.id);
  }

  public async transcribeChunk(input: {
    filePath: string;
    model?: string;
    inputLanguage?: string;
  }): Promise<TranscriptionChunkResult> {
    const request = {
      recognizer: this.config.providers.googleCloud.speechRecognizer,
      config: {
        autoDecodingConfig: {},
        languageCodes: input.inputLanguage ? [input.inputLanguage] : ['auto'],
        model: this.resolveModel(input.model),
        features: {
          enableWordTimeOffsets: true,
        },
      },
      content: await readFile(input.filePath),
    };
    const [response] = await this.client.recognize(request as never);
    const results = (response as {
      results?: Array<{
        alternatives?: Array<{
          transcript?: string;
          words?: Array<{
            startOffset?: { seconds?: number; nanos?: number };
            endOffset?: { seconds?: number; nanos?: number };
            word?: string;
            speakerLabel?: string;
          }>;
        }>;
        languageCode?: string;
      }>;
    }).results ?? [];
    const segments: MediaSegment[] = [];
    const transcriptParts: string[] = [];
    let detectedLanguage: string | null = null;
    for (const result of results) {
      const alternative = result.alternatives?.[0];
      if (!alternative?.transcript) {
        continue;
      }
      transcriptParts.push(alternative.transcript);
      detectedLanguage ??= result.languageCode ?? null;
      const words = alternative.words ?? [];
      const start = words[0]?.startOffset?.seconds ?? 0;
      const end = words.at(-1)?.endOffset?.seconds ?? start;
      segments.push({
        startMs: Math.round(Number(start) * 1000),
        endMs: Math.round(Number(end) * 1000),
        text: alternative.transcript,
      });
    }
    return {
      text: transcriptParts.join(' ').trim(),
      detectedLanguage,
      segments,
      raw: response,
    };
  }
}

export class ProviderRegistry {
  private readonly openaiProvider: OpenAiProvider;
  private readonly geminiProvider: GoogleGeminiProvider;
  private readonly googleSpeechProvider: GoogleSpeechProvider;

  public constructor(private readonly config: AppConfig) {
    this.openaiProvider = new OpenAiProvider(config);
    this.geminiProvider = new GoogleGeminiProvider(config);
    this.googleSpeechProvider = new GoogleSpeechProvider(config);
  }

  public transcriptionProvider(providerId: ProviderId): TranscriptionProvider {
    switch (providerId) {
      case 'openai':
        if (!this.config.providers.openai.enabled) {
          throw new Error('OpenAI provider is disabled');
        }
        return this.openaiProvider;
      case 'google-gemini':
        if (!this.config.providers.gemini.enabled) {
          throw new Error('Gemini provider is disabled');
        }
        return this.geminiProvider;
      case 'google-speech':
        if (!this.config.providers.googleCloud.enabled) {
          throw new Error('Google Cloud provider is disabled');
        }
        return this.googleSpeechProvider;
      default:
        throw new Error(`Unsupported transcription provider: ${providerId}`);
    }
  }

  public understandingProvider(providerId: ProviderId): UnderstandingProvider {
    if (providerId !== 'google-gemini') {
      throw new Error(`Unsupported understanding provider: ${providerId}`);
    }
    if (!this.config.providers.gemini.enabled) {
      throw new Error('Gemini provider is disabled');
    }
    return this.geminiProvider;
  }

  public async translateWithBestAvailable(input: {
    preferredProvider: ProviderId;
    model?: string;
    text: string;
    targetLanguage: string;
  }): Promise<string> {
    const candidates: ProviderId[] = [
      input.preferredProvider,
      'google-gemini',
      'openai',
    ];
    for (const providerId of candidates) {
      const provider = this.transcriptionProvider(providerId);
      if (!provider.translateText) {
        continue;
      }
      return provider.translateText({
        ...(input.model ? { model: input.model } : {}),
        text: input.text,
        targetLanguage: input.targetLanguage,
      });
    }
    throw new Error('No translation-capable provider is configured');
  }
}
