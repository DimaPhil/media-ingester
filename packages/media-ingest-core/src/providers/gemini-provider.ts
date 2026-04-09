import {
  GoogleGenAI,
  createPartFromText,
  createPartFromUri,
  createUserContent,
} from '@google/genai';

import type { AppConfig } from '../config';
import type { ProviderCapability } from '../media';

import { parseJsonObject, providerCapabilityFor } from './shared';
import type {
  TranscriptionChunkResult,
  TranscriptionProvider,
  UnderstandingChunkResult,
  UnderstandingProvider,
} from './types';

interface UploadedGeminiFile {
  name?: string;
  uri?: string;
  mimeType?: string;
}

export class GoogleGeminiProvider implements TranscriptionProvider, UnderstandingProvider {
  public readonly id = 'google-gemini' as const;
  private client?: GoogleGenAI;

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

  private getClient(): GoogleGenAI {
    this.client ??= new GoogleGenAI({
      apiKey: this.config.providers.gemini.apiKey,
    });
    return this.client;
  }

  private async withUploadedFile<T>(
    input: {
      filePath: string;
      mimeType: string;
      model: string;
      prompt: string;
    },
    parse: (responseText: string, uploadedFile: UploadedGeminiFile) => T,
  ): Promise<T> {
    const client = this.getClient();
    const uploadedFile = await client.files.upload({
      file: input.filePath,
      config: {
        mimeType: input.mimeType,
      },
    });

    try {
      if (!uploadedFile.uri || !uploadedFile.mimeType) {
        throw new Error('Gemini file upload did not return a URI and mime type');
      }
      const response = await client.models.generateContent({
        model: input.model,
        contents: [
          createUserContent([
            createPartFromText(input.prompt),
            createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
          ]),
        ],
        config: {
          responseMimeType: 'application/json',
        },
      });
      return parse(response.text ?? '', uploadedFile);
    } finally {
      if (uploadedFile.name) {
        await client.files.delete({ name: uploadedFile.name }).catch(() => undefined);
      }
    }
  }

  public async transcribeChunk(input: {
    filePath: string;
    model?: string;
    inputLanguage?: string;
  }): Promise<TranscriptionChunkResult> {
    return this.withUploadedFile(
      {
        filePath: input.filePath,
        mimeType: 'audio/mpeg',
        model: this.resolveModel(input.model),
        prompt: [
          'Transcribe the media in the source language.',
          input.inputLanguage ? `The expected language is ${input.inputLanguage}.` : 'Auto-detect the language.',
          'Return strict JSON: {"text": string, "detectedLanguage": string|null, "segments": [{"startMs": number, "endMs": number, "text": string, "speaker"?: string}]}.',
        ].join(' '),
      },
      (responseText, uploadedFile) => {
        const payload = parseJsonObject<{
          text: string;
          detectedLanguage?: string;
          segments?: Array<{
            startMs: number;
            endMs: number;
            text: string;
            speaker?: string;
          }>;
        }>(responseText);
        return {
          text: payload.text,
          detectedLanguage: payload.detectedLanguage ?? null,
          segments: payload.segments ?? [],
          raw: {
            payload,
            uploadedFile,
          },
        };
      },
    );
  }

  public async understandChunk(input: {
    filePath: string;
    model?: string;
    prompt: string;
  }): Promise<UnderstandingChunkResult> {
    return this.withUploadedFile(
      {
        filePath: input.filePath,
        mimeType: 'video/mp4',
        model: this.resolveUnderstandingModel(input.model),
        prompt: `${input.prompt}\nReturn strict JSON: {"responseText": string, "timeRanges": [{"startMs": number, "endMs": number, "label"?: string}]}.`,
      },
      (responseText, uploadedFile) => {
        const payload = parseJsonObject<{
          responseText: string;
          timeRanges?: Array<{ startMs: number; endMs: number; label?: string }>;
        }>(responseText);
        return {
          responseText: payload.responseText,
          timeRanges: payload.timeRanges,
          raw: {
            payload,
            uploadedFile,
          },
        };
      },
    );
  }

  public async translateText(input: {
    model?: string;
    text: string;
    targetLanguage: string;
  }): Promise<string> {
    const response = await this.getClient().models.generateContent({
      model: this.resolveUnderstandingModel(input.model),
      contents:
        `Translate the following transcript to ${input.targetLanguage}. `
        + 'Return strict JSON: {"translatedText": string}.\n\n'
        + input.text,
      config: {
        responseMimeType: 'application/json',
      },
    });
    const payload = parseJsonObject<{ translatedText: string }>(response.text ?? '');
    return payload.translatedText;
  }
}
