import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { HealthController, OperationsController } from '../src/controllers';
import { APP_CONFIG } from '../src/tokens';
import type { AppConfig } from '@media-ingest/core';
import { RemoteOperationService } from '@media-ingest/core';

const config: AppConfig = {
  app: { env: 'test', host: '127.0.0.1', port: 3000, pollAfterMs: 10 },
  features: { cacheEnabled: true },
  storage: {
    workingDirectory: '/tmp',
    completedRetentionHours: 24,
    failedRetentionHours: 4,
    cleanupCron: '0 * * * *',
    ytDlpCookiesFromBrowser: '',
    ytDlpCookiesPath: '',
  },
  database: { url: 'postgres://unused' },
  providers: {
    openai: {
      enabled: true,
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o-transcribe',
      diarizeModel: 'gpt-4o-transcribe',
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

describe('API controllers', () => {
  it('returns health information', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: APP_CONFIG, useValue: config }],
    }).compile();

    expect(moduleRef.get(HealthController).healthz()).toEqual({
      status: 'ok',
      env: 'test',
    });
  });

  it('renders the admin page shell', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: APP_CONFIG, useValue: config }],
    }).compile();

    const response = {
      type: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    moduleRef.get(HealthController).admin(response as never);
    expect(response.type).toHaveBeenCalledWith('html');
    expect(response.send).toHaveBeenCalledWith(expect.stringContaining('Media Ingest Control Room'));
  });

  it('delegates operation lookup to the service', async () => {
    const operations = {
      getOperationStatus: vi.fn().mockResolvedValue({ operation: { id: 'op-1', status: 'completed' } }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [OperationsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: RemoteOperationService, useValue: operations },
      ],
    }).compile();

    const controller = moduleRef.get(OperationsController);
    await expect(controller.getOperation('op-1')).resolves.toEqual({
      operation: { id: 'op-1', status: 'completed' },
    });
    expect(operations.getOperationStatus).toHaveBeenCalledWith('op-1');
  });

  it('maps validation errors to bad request responses', async () => {
    const operations = {
      submitTranscription: vi.fn().mockRejectedValue(new ZodError([])),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [OperationsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: RemoteOperationService, useValue: operations },
      ],
    }).compile();

    const controller = moduleRef.get(OperationsController);
    await expect(controller.createTranscription({})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns filtered admin operations lists', async () => {
    const operations = {
      listOperations: vi.fn().mockResolvedValue([{ id: 'op-2', status: 'running' }]),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [OperationsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: RemoteOperationService, useValue: operations },
      ],
    }).compile();

    const controller = moduleRef.get(OperationsController);
    await expect(controller.listOperations('25', 'running', 'transcription', 'openai', 'http')).resolves.toEqual({
      items: [{ id: 'op-2', status: 'running' }],
      meta: { limit: 25, count: 1 },
    });
  });

  it('returns admin overview payloads', async () => {
    const operations = {
      getAdminOverview: vi.fn().mockResolvedValue({ counts: { total: 1 } }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [OperationsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: RemoteOperationService, useValue: operations },
      ],
    }).compile();

    await expect(moduleRef.get(OperationsController).getAdminOverview()).resolves.toEqual({
      counts: { total: 1 },
    });
  });

  it('maps missing operations to not found responses', async () => {
    const operations = {
      getOperationStatus: vi.fn().mockRejectedValue(new Error('Operation not found: missing')),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [OperationsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: RemoteOperationService, useValue: operations },
      ],
    }).compile();

    const controller = moduleRef.get(OperationsController);
    await expect(controller.getOperation('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps unexpected service errors to bad request responses', async () => {
    const operations = {
      createUnderstanding: vi.fn(),
      submitUnderstanding: vi.fn().mockRejectedValue(new Error('unexpected')),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [OperationsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: RemoteOperationService, useValue: operations },
      ],
    }).compile();

    const controller = moduleRef.get(OperationsController);
    await expect(
      controller.createUnderstanding({
        source: { kind: 'http', uri: 'https://example.com/video.mp4' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
