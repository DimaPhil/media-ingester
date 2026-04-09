import { readFile } from 'node:fs/promises';

import OpenAI from 'openai';

import type { AppConfig } from '../config';
import type { ProviderCapability } from '../media';

import {
  buildOpenAiTranscriptionRequestOptions,
  normalizeOpenAiTranscriptionPayload,
  providerCapabilityFor,
} from './shared';
import type { TranscriptionChunkResult, TranscriptionProvider } from './types';

export class OpenAiProvider implements TranscriptionProvider {
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
    return normalizeOpenAiTranscriptionPayload(response);
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
