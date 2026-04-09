#!/usr/bin/env node

import { Command } from 'commander';

import {
  LocalMediaProcessor,
  ProviderRegistry,
  SourceRegistry,
  loadAppConfig,
  type AppConfig,
} from '@media-ingest/core';

import { defaultCliConfigPath, loadCliConfig } from './config';

function applyCliEnv(config: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENAI_API_KEY: config.openaiApiKey,
    GEMINI_API_KEY: config.geminiApiKey,
    GOOGLE_CLOUD_PROJECT_ID: config.googleCloudProjectId,
    GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON: config.googleCloudServiceAccountJson,
    GOOGLE_LOCATION: config.googleCloudLocation,
    MEDIA_INGEST_CONFIG_PATH: config.mediaIngestConfigPath,
  };
}

async function resolveCoreConfig(cliConfigPath?: string): Promise<AppConfig> {
  const cliConfig = await loadCliConfig(cliConfigPath);
  return loadAppConfig({
    configPath: cliConfig.mediaIngestConfigPath,
    env: applyCliEnv(cliConfig),
  });
}

async function apiRequest(
  path: string,
  init: RequestInit,
  cliConfigPath?: string,
): Promise<unknown> {
  const cliConfig = await loadCliConfig(cliConfigPath);
  const baseUrl = cliConfig.apiBaseUrl ?? 'http://localhost:3000';
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cliConfig.apiToken ? { Authorization: `Bearer ${cliConfig.apiToken}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(
      typeof payload === 'object' && payload && 'message' in payload
        ? String((payload as { message: string }).message)
        : `Request failed with status ${response.status}`,
    );
  }
  return payload;
}

async function createLocalProcessor(cliConfigPath?: string): Promise<LocalMediaProcessor> {
  const config = await resolveCoreConfig(cliConfigPath);
  return new LocalMediaProcessor(config, new SourceRegistry(config), new ProviderRegistry(config));
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runLocalTranscription(
  path: string,
  options: {
    provider: string;
    model?: string;
    inputLanguage?: string;
    targetLanguage?: string;
  },
  cliConfigPath?: string,
): Promise<void> {
  const processor = await createLocalProcessor(cliConfigPath);
  printJson(
    await processor.transcribe({
      source: {
        kind: 'local_file',
        uri: path,
      },
      provider: options.provider,
      model: options.model,
      inputLanguage: options.inputLanguage,
      targetLanguage: options.targetLanguage,
      force: true,
    }),
  );
}

async function runLocalUnderstanding(
  path: string,
  options: {
    provider: string;
    prompt: string;
    model?: string;
  },
  cliConfigPath?: string,
): Promise<void> {
  const processor = await createLocalProcessor(cliConfigPath);
  printJson(
    await processor.understand({
      source: {
        kind: 'local_file',
        uri: path,
      },
      provider: options.provider,
      model: options.model,
      prompt: options.prompt,
      force: true,
    }),
  );
}

const program = new Command();

program
  .name('media-ingest')
  .description('Media ingest CLI for the media-ingest API and local-file processing')
  .option('--config <path>', 'Path to CLI config JSON', defaultCliConfigPath);

program
  .command('status')
  .argument('<operationId>', 'Operation identifier')
  .action(async (operationId, options, command) => {
    const cliConfigPath = command.parent?.opts().config as string | undefined;
    printJson(await apiRequest(`/v1/operations/${operationId}`, { method: 'GET' }, cliConfigPath));
  });

const transcribe = program.command('transcribe').description('Transcription commands');

transcribe
  .argument('[path]', 'Local media path')
  .option('--provider <provider>', 'Provider id')
  .option('--model <model>', 'Provider model')
  .option('--input-language <language>', 'Input language')
  .option('--target-language <language>', 'Target translation language')
  .action(async (path, options, command) => {
    if (!path) {
      command.help();
    }
    if (!options.provider) {
      throw new Error('--provider is required for local transcription');
    }
    const cliConfigPath = command.parent?.opts().config as string | undefined;
    await runLocalTranscription(path as string, options, cliConfigPath);
  });

transcribe
  .command('submit')
  .requiredOption('--source-kind <kind>', 'Source kind')
  .requiredOption('--source-uri <uri>', 'Source URI')
  .requiredOption('--provider <provider>', 'Provider id')
  .option('--model <model>', 'Provider model')
  .option('--input-language <language>', 'Input language')
  .option('--target-language <language>', 'Target translation language')
  .option('--force', 'Disable cache reuse', false)
  .action(async (options, command) => {
    const cliConfigPath = command.parent?.parent?.opts().config as string | undefined;
    printJson(
      await apiRequest(
        '/v1/transcriptions',
        {
          method: 'POST',
          body: JSON.stringify({
            source: {
              kind: options.sourceKind,
              uri: options.sourceUri,
            },
            provider: options.provider,
            model: options.model,
            inputLanguage: options.inputLanguage,
            targetLanguage: options.targetLanguage,
            force: options.force,
          }),
        },
        cliConfigPath,
      ),
    );
  });

const understand = program.command('understand').description('Understanding commands');

understand
  .argument('[path]', 'Local media path')
  .option('--provider <provider>', 'Provider id')
  .option('--prompt <prompt>', 'Understanding prompt')
  .option('--model <model>', 'Provider model')
  .action(async (path, options, command) => {
    if (!path) {
      command.help();
    }
    if (!options.provider) {
      throw new Error('--provider is required for local understanding');
    }
    if (!options.prompt) {
      throw new Error('--prompt is required for local understanding');
    }
    const cliConfigPath = command.parent?.opts().config as string | undefined;
    await runLocalUnderstanding(path as string, options, cliConfigPath);
  });

understand
  .command('submit')
  .requiredOption('--source-kind <kind>', 'Source kind')
  .requiredOption('--source-uri <uri>', 'Source URI')
  .requiredOption('--provider <provider>', 'Provider id')
  .requiredOption('--prompt <prompt>', 'Understanding prompt')
  .option('--model <model>', 'Provider model')
  .option('--force', 'Disable cache reuse', false)
  .action(async (options, command) => {
    const cliConfigPath = command.parent?.parent?.opts().config as string | undefined;
    printJson(
      await apiRequest(
        '/v1/understanding',
        {
          method: 'POST',
          body: JSON.stringify({
            source: {
              kind: options.sourceKind,
              uri: options.sourceUri,
            },
            provider: options.provider,
            model: options.model,
            prompt: options.prompt,
            force: options.force,
          }),
        },
        cliConfigPath,
      ),
    );
  });

const local = program.command('local').description('Local-file processing');

local
  .command('transcribe')
  .argument('<path>', 'Local media path')
  .requiredOption('--provider <provider>', 'Provider id')
  .option('--model <model>', 'Provider model')
  .option('--input-language <language>', 'Input language')
  .option('--target-language <language>', 'Target language')
  .action(async (path, options, command) => {
    const cliConfigPath = command.parent?.parent?.opts().config as string | undefined;
    await runLocalTranscription(path, options, cliConfigPath);
  });

local
  .command('understand')
  .argument('<path>', 'Local media path')
  .requiredOption('--provider <provider>', 'Provider id')
  .requiredOption('--prompt <prompt>', 'Understanding prompt')
  .option('--model <model>', 'Provider model')
  .action(async (path, options, command) => {
    const cliConfigPath = command.parent?.parent?.opts().config as string | undefined;
    await runLocalUnderstanding(path, options, cliConfigPath);
  });

program
  .command('config')
  .description('Inspect CLI config')
  .action(async (_, command) => {
    const cliConfigPath = command.parent?.opts().config as string | undefined;
    printJson({
      path: cliConfigPath ?? defaultCliConfigPath,
      config: await loadCliConfig(cliConfigPath),
    });
  });

void program.parseAsync(process.argv);
