import { readFile } from 'node:fs/promises';
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

export class ClaudeReasoner implements SubscriptionReasoner {
  readonly provider = 'claude-code';
  credentialHome(options: SubscriptionUnderstandingOptions) {
    return options.claudeHome;
  }

  async run(
    { prompt, frames, jsonSchema, model }: ReasoningInput,
    options: SubscriptionUnderstandingOptions,
    processOptions: SubscriptionProcessOptions,
  ): Promise<unknown> {
    const status = await runSubscriptionProcess(
      options.claudePath ?? 'claude',
      ['auth', 'status', '--json'],
      processOptions,
    );
    let auth: { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
    try {
      auth = JSON.parse(status.stdout);
    } catch {
      throw new MediaError(
        'subscription_auth_required',
        'Native Claude subscription login is required',
      );
    }
    if (
      auth?.loggedIn !== true ||
      auth.authMethod !== 'claude.ai' ||
      auth.apiProvider !== 'firstParty'
    )
      throw new MediaError(
        'subscription_auth_required',
        'Native Claude subscription login is required',
      );
    const content: unknown[] = [{ type: 'text', text: prompt }];
    for (const frame of frames) {
      content.push({ type: 'text', text: `Frame timestamp: ${frame.timestampMs} ms` });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: (await readFile(frame.path)).toString('base64'),
        },
      });
    }
    const result = await runSubscriptionProcess(
      options.claudePath ?? 'claude',
      [
        '-p',
        '--safe-mode',
        '--tools',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--setting-sources',
        '',
        '--settings',
        '{"disableAllHooks":true}',
        '--no-session-persistence',
        '--no-chrome',
        '--disable-slash-commands',
        '--permission-mode',
        'dontAsk',
        '--permission-prompts',
        'none',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        model,
        '--json-schema',
        jsonSchema,
      ],
      {
        ...processOptions,
        input:
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content },
            parent_tool_use_id: null,
            session_id: '',
          }) + '\n',
      },
    );
    const events = result.stdout
      .split('\n')
      .filter((line) => line.trim())
      .map(
        (line) =>
          JSON.parse(line) as { type?: string; is_error?: boolean; structured_output?: unknown },
      );
    const final = events.reverse().find((event) => event.type === 'result');
    if (!final || final.is_error || !final.structured_output)
      throw new MediaError(
        'subscription_invalid_output',
        'Claude did not return successful structured output',
      );
    return final.structured_output;
  }
}
