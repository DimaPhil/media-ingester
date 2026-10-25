import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { MediaClient } from '@media-ingest/client';
import {
  jsonSchema,
  operationIds,
  operations,
  RELEASE_VERSION,
  requestSchema,
  type MediaRequest,
  type Source,
} from '@media-ingest/contracts';
import { complete, completionScript } from './completion.js';
import { loadConfig, saveConfig } from './config.js';

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
type JsonOptions = { input?: string; file?: string };
export interface CliIO {
  out: (value: string) => void;
  stdin: () => Promise<string>;
  env: NodeJS.ProcessEnv;
}
async function standardInput(): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of process.stdin) {
    const data = Buffer.from(part);
    size += data.length;
    if (size > 48 * 1024 * 1024) throw new Error('Standard input exceeds 48 MiB');
    parts.push(data);
  }
  return Buffer.concat(parts).toString('utf8');
}
export const defaultIO: CliIO = {
  out: (value) => process.stdout.write(value + '\n'),
  stdin: standardInput,
  env: process.env,
};
async function inputJSON(options: JsonOptions, io: CliIO): Promise<Record<string, unknown>> {
  if (options.input && options.file) throw new Error('Use either --input or --file');
  const text =
    options.input ??
    (options.file === '-'
      ? await io.stdin()
      : options.file
        ? await readFile(options.file, 'utf8')
        : '{}');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Input must be valid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Input must be a JSON object');
  return data as Record<string, unknown>;
}
export async function uploadFile(client: MediaClient, path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_UPLOAD_BYTES)
    throw new Error('Upload must be a regular file no larger than 32 MiB');
  const bytes = await readFile(path);
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('Upload exceeds 32 MiB');
  return client.call('upload', { fileName: basename(path), data: bytes.toString('base64') });
}
function inferSource(value: string, kind?: string): Source {
  const resolved =
    kind ??
    (/^https?:\/\//u.test(value)
      ? /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//u.test(value)
        ? 'youtube'
        : 'http'
      : 'local_file');
  return { kind: resolved as Source['kind'], uri: value };
}

export function createProgram(io: CliIO = defaultIO): Command {
  const program = new Command()
    .name('media')
    .description('Authenticated HTTP client for Media Ingest')
    .version(RELEASE_VERSION);
  program.configureOutput({
    writeOut: (value) => io.out(value.trimEnd()),
    writeErr: (value) => io.out(value.trimEnd()),
  });
  const client = async () => new MediaClient(await loadConfig(io.env));
  const print = (value: unknown) => io.out(JSON.stringify(value, null, 2));

  for (const id of operationIds) {
    const operation = operations[id];
    const command = program
      .command(id)
      .description(operation.description)
      .option('--input <json>', 'JSON request object')
      .option('--file <path>', 'Read JSON request from file; - reads stdin');
    if (operation.path.includes(':id')) command.argument('[id]', 'Job UUID');
    if (id === 'upload') command.argument('[path]', 'Local file to upload');
    command.action(async (...args: unknown[]) => {
      const positional = operation.path.includes(':id') || id === 'upload';
      const value = positional ? (args[0] as string | undefined) : undefined;
      const options = args[positional ? 1 : 0] as JsonOptions;
      if (id === 'upload' && value) {
        if (options.input || options.file)
          throw new Error('Use upload <path> or a JSON request, not both');
        print(await uploadFile(await client(), value));
        return;
      }
      const input = await inputJSON(options, io);
      if (value) {
        if (input.id !== undefined && input.id !== value)
          throw new Error('Positional ID conflicts with JSON ID');
        input.id = value;
      }
      // Runtime catalog validation remains authoritative, including newly added commands.
      print(await (await client()).call(id, input as never));
    });
  }

  for (const [name, kind] of [
    ['transcribe', 'transcription'],
    ['understand', 'understanding'],
  ] as const) {
    program
      .command(name)
      .description(`Upload if local, then queue ${kind} through the API`)
      .argument('<source>', 'File path or remote URI')
      .option('--source-kind <kind>', 'Explicit source kind')
      .option(
        '--provider <provider>',
        'Provider',
        kind === 'understanding' ? 'google-gemini' : 'openai',
      )
      .option('--model <model>')
      .option('--prompt <prompt>')
      .option('--input-language <language>')
      .option('--target-language <language>')
      .option('--idempotency-key <key>')
      .action(
        async (
          sourceValue: string,
          options: {
            sourceKind?: string;
            provider: MediaRequest['provider'];
            model?: string;
            prompt?: string;
            inputLanguage?: string;
            targetLanguage?: string;
            idempotencyKey?: string;
          },
        ) => {
          const api = await client();
          const source = inferSource(sourceValue, options.sourceKind);
          const request = requestSchema.parse({
            kind,
            source,
            provider: options.provider,
            model: options.model,
            prompt: options.prompt,
            inputLanguage: options.inputLanguage,
            targetLanguage: options.targetLanguage,
          });
          if (source.kind === 'local_file')
            request.source = (await uploadFile(api, source.uri)).source;
          print(
            await api.call(
              'submit',
              operations.submit.input.parse({ request, idempotencyKey: options.idempotencyKey }),
            ),
          );
        },
      );
  }
  program
    .command('setup')
    .description('Save API URL and token with owner-only permissions')
    .requiredOption('--url <url>')
    .option('--token-stdin', 'Read token from stdin; otherwise use MEDIA_API_TOKEN')
    .action(async (options: { url: string; tokenStdin?: boolean }) => {
      const token = options.tokenStdin ? (await io.stdin()).trim() : io.env.MEDIA_API_TOKEN;
      if (!token) throw new Error('Supply the token through stdin or MEDIA_API_TOKEN');
      print({ configured: true, path: await saveConfig({ baseUrl: options.url, token }, io.env) });
    });
  program
    .command('schema')
    .description('Show command request/response JSON schemas without network access')
    .argument('[operation]')
    .action((id?: string) => {
      if (id && !operationIds.includes(id as never)) throw new Error('Unknown operation');
      print(
        (id ? [id as keyof typeof operations] : operationIds).map((name) => ({
          name,
          method: operations[name].method,
          path: operations[name].path,
          input: jsonSchema(operations[name].input),
          output: jsonSchema(operations[name].output),
        })),
      );
    });
  program
    .command('completion')
    .description('Print shell completion script')
    .argument('<shell>', 'bash, zsh or fish')
    .action((shell: string) => io.out(completionScript(shell).trimEnd()));
  program
    .command('__complete', { hidden: true })
    .allowUnknownOption()
    .argument('[words...]')
    .action((words: string[]) => io.out(complete(words).join('\n')));
  program
    .command('skill')
    .description('Manage the bundled agent skill')
    .command('install')
    .description('Install or repair the managed skill without overwriting edits')
    .action(async () => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL('../scripts/postinstall.mjs', import.meta.url)), '--explicit'],
        { env: io.env },
      );
      io.out(stdout.trimEnd());
    });
  return program;
}
