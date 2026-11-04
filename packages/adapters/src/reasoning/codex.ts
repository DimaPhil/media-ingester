import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MediaError } from '@media-ingest/sdk';
import {
  runSubscriptionProcess,
  type SubscriptionProcessOptions,
} from '../subscription-runtime.js';
import type {
  ReasoningInput,
  SubscriptionReasoner,
  SubscriptionUnderstandingOptions,
} from './reasoner.js';

export class CodexReasoner implements SubscriptionReasoner {
  readonly provider = 'codex';
  credentialHome(options: SubscriptionUnderstandingOptions) {
    return options.codexHome;
  }

  async run(
    { prompt, frames, jsonSchema, model }: ReasoningInput,
    options: SubscriptionUnderstandingOptions,
    processOptions: SubscriptionProcessOptions,
  ): Promise<unknown> {
    const schemaPath = join(processOptions.cwd, 'response-schema.json');
    const outputPath = join(processOptions.cwd, 'response.json');
    await writeFile(schemaPath, jsonSchema, { mode: 0o600 });
    await runSubscriptionProcess(
      options.codexPath ?? 'codex',
      [
        'exec',
        '--ignore-user-config',
        '--ignore-rules',
        '--ephemeral',
        '--skip-git-repo-check',
        '-s',
        'read-only',
        '-m',
        model,
        '-c',
        'features.shell_tool=false',
        '-c',
        'forced_login_method="chatgpt"',
        '-c',
        'cli_auth_credentials_store="file"',
        '-c',
        'features.unified_exec=false',
        '-c',
        'features.hooks=false',
        '-c',
        'features.multi_agent=false',
        '-c',
        'mcp_servers={}',
        '-c',
        'web_search="disabled"',
        '-c',
        'project_doc_max_bytes=0',
        '--output-schema',
        schemaPath,
        '-o',
        outputPath,
        ...frames.flatMap((frame) => ['--image', frame.path]),
        '-',
      ],
      {
        ...processOptions,
        input: prompt,
      },
    );
    if ((await stat(outputPath)).size > 4 * 1024 * 1024)
      throw new MediaError('subscription_output_too_large', 'Structured response exceeds 4 MiB');
    return JSON.parse(await readFile(outputPath, 'utf8'));
  }
}
