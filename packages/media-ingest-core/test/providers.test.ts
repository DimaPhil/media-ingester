import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createTranscriptionMock,
  createResponseMock,
  toFileMock,
} = vi.hoisted(() => ({
  createTranscriptionMock: vi.fn(),
  createResponseMock: vi.fn(),
  toFileMock: vi.fn(async (_contents: Buffer, fileName: string) => ({ fileName })),
}));

vi.mock('openai', () => {
  class MockOpenAI {
    public static toFile = toFileMock;
    public readonly audio = {
      transcriptions: {
        create: createTranscriptionMock,
      },
    };
    public readonly responses = {
      create: createResponseMock,
    };

    public constructor(_config: unknown) {}
  }

  return { default: MockOpenAI };
});

import type { AppConfig } from '../src/config';
import {
  ProviderRegistry,
  buildOpenAiTranscriptionRequestOptions,
} from '../src/providers';

function createConfig(): AppConfig {
  return {
    app: {
      env: 'test',
      host: '127.0.0.1',
      port: 3000,
      pollAfterMs: 10,
    },
    features: {
      cacheEnabled: true,
    },
    storage: {
      workingDirectory: '/tmp',
      completedRetentionHours: 24,
      failedRetentionHours: 4,
      cleanupCron: '0 * * * *',
      ytDlpCookiesFromBrowser: '',
      ytDlpCookiesPath: '',
    },
    database: {
      url: 'postgres://unused',
    },
    providers: {
      openai: {
        enabled: true,
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-transcribe',
        diarizeModel: 'gpt-4o-transcribe-diarize',
        translationModel: 'gpt-4.1-mini',
      },
      gemini: {
        enabled: true,
        apiKey: '',
        geminiTranscriptionModel: 'gemini-2.5-flash',
        geminiUnderstandingModel: 'gemini-2.5-pro',
      },
      googleCloud: {
        enabled: true,
        projectId: '',
        location: 'global',
        speechRecognizer: 'projects/_/locations/global/recognizers/_',
        serviceAccountJson: '',
      },
    },
    sources: {
      googleDrive: { enabled: true },
      telegram: { enabled: true, baseUrl: 'http://localhost:8080', bearerToken: '' },
      ytDlp: { enabled: true, binaryPath: 'yt-dlp' },
      http: { enabled: true, timeoutMs: 1000 },
    },
  };
}

describe('OpenAI transcription request options', () => {
  it('uses verbose_json only for whisper models', () => {
    expect(buildOpenAiTranscriptionRequestOptions('whisper-1')).toEqual({
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });
  });

  it('uses json for gpt-4o transcribe models', () => {
    expect(buildOpenAiTranscriptionRequestOptions('gpt-4o-transcribe-api-v3')).toEqual({
      response_format: 'json',
    });
  });

  it('uses diarized_json for diarization models', () => {
    expect(buildOpenAiTranscriptionRequestOptions('gpt-4o-transcribe-diarize')).toEqual({
      response_format: 'diarized_json',
    });
  });
});

describe('OpenAI provider', () => {
  beforeEach(() => {
    createTranscriptionMock.mockReset();
    createResponseMock.mockReset();
    toFileMock.mockClear();
  });

  it('sends json response format for gpt-4o transcribe models', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'media-ingest-openai-'));
    const filePath = join(fixtureDirectory, 'audio.mp3');
    await writeFile(filePath, 'fake');

    createTranscriptionMock.mockResolvedValue({
      text: 'hello world',
      language: 'en',
    });

    const provider = new ProviderRegistry(createConfig()).transcriptionProvider('openai');
    const result = await provider.transcribeChunk({
      filePath,
      model: 'gpt-4o-transcribe-api-v3',
    });

    expect(createTranscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o-transcribe-api-v3',
        response_format: 'json',
      }),
    );
    expect(createTranscriptionMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        timestamp_granularities: expect.anything(),
      }),
    );
    expect(result.text).toBe('hello world');
    expect(result.detectedLanguage).toBe('en');
  });

  it('sends diarized_json for diarization models and maps speakers', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'media-ingest-openai-'));
    const filePath = join(fixtureDirectory, 'audio.mp3');
    await writeFile(filePath, 'fake');

    createTranscriptionMock.mockResolvedValue({
      text: 'hi there',
      language: 'en',
      segments: [
        {
          start: 0,
          end: 1.25,
          text: 'hi there',
          speaker: 'speaker_1',
        },
      ],
    });

    const provider = new ProviderRegistry(createConfig()).transcriptionProvider('openai');
    const result = await provider.transcribeChunk({
      filePath,
      model: 'gpt-4o-transcribe-diarize',
    });

    expect(createTranscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o-transcribe-diarize',
        response_format: 'diarized_json',
      }),
    );
    expect(result.segments).toEqual([
      {
        startMs: 0,
        endMs: 1250,
        text: 'hi there',
        speaker: 'speaker_1',
      },
    ]);
  });
});
