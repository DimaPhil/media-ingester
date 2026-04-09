import type { AppConfig } from '../config';
import type { ProviderId } from '../types';

import { GoogleGeminiProvider } from './gemini-provider';
import { GoogleSpeechProvider } from './google-speech-provider';
import { OpenAiProvider } from './openai-provider';
import type { TranscriptionProvider, UnderstandingProvider } from './types';

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
      let provider: TranscriptionProvider;
      try {
        provider = this.transcriptionProvider(providerId);
      } catch {
        continue;
      }
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
