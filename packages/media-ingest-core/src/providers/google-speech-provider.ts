import { readFile } from 'node:fs/promises';

import { SpeechClient } from '@google-cloud/speech';

import type { AppConfig } from '../config';
import type { ProviderCapability } from '../media';
import type { MediaSegment } from '../types';

import { providerCapabilityFor } from './shared';
import type { TranscriptionChunkResult, TranscriptionProvider } from './types';

export class GoogleSpeechProvider implements TranscriptionProvider {
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
