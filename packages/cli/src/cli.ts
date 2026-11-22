import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { MediaClient } from '@media-ingest/client';
import { jsonSchema, operations, operationIds, RELEASE_VERSION } from '@media-ingest/contracts';
import { registerCatalogCommands } from './catalog-commands.js';
import { registerMediaCommands } from './media-commands.js';
import { complete, completionScript } from './completion.js';
import { loadConfig, saveConfig } from './config.js';
import { addExamples, describeCliError, UsageError, withHelp } from './output.js';

export { inferSource, uploadFile } from './media-commands.js';

export interface CliIO {
  /** Results and errors as JSON. */
  out: (value: string) => void;
  /** Progress and diagnostics; defaults to `out` when absent. */
  err?: (value: string) => void;
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
  err: (value) => process.stderr.write(value + '\n'),
  stdin: standardInput,
  env: process.env,
};
export interface ProgramOptions {
  /** Leave error reporting to the caller, which prints one JSON error instead of commander text. */
  jsonErrors?: boolean;
}
/** Commands throw instead of exiting the process; `runCli` turns failures into JSON and exit codes. */
export function createProgram(io: CliIO = defaultIO, options: ProgramOptions = {}): Command {
  const diagnostic = io.err ?? io.out;
  // Subcommands copy these settings when they are created, so configure them first.
  const program = new Command()
    .name('media')
    .description('Authenticated HTTP client for Media Ingest. Prints JSON to stdout.')
    .version(RELEASE_VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (value) => io.out(value.trimEnd()),
      writeErr: (value) => diagnostic(value.trimEnd()),
      ...(options.jsonErrors ? { outputError: () => {} } : {}),
    });
  program.addHelpText(
    'after',
    '\nErrors print {"error":{code,message,details?},"help":[...]} to stdout.\nExit codes: 0 success, 1 failure, 2 usage error. Job views list follow-up commands in "help".',
  );
  const client = async () => new MediaClient(await loadConfig(io.env));
  const print = (value: unknown) => io.out(JSON.stringify(withHelp(value), null, 2));

  registerCatalogCommands(program, client, print, () => io.stdin());
  registerMediaCommands(program, client, print, diagnostic);
  program
    .command('setup')
    .description('Save API URL and token with owner-only permissions')
    .requiredOption('--url <url>')
    .option('--token-stdin', 'Read token from stdin; otherwise use MEDIA_API_TOKEN')
    .action(async (options: { url: string; tokenStdin?: boolean }) => {
      const token = options.tokenStdin ? (await io.stdin()).trim() : io.env.MEDIA_API_TOKEN;
      if (!token) throw new UsageError('Supply the token through stdin or MEDIA_API_TOKEN');
      print({ configured: true, path: await saveConfig({ baseUrl: options.url, token }, io.env) });
    });
  program
    .command('schema')
    .description('Show command request/response JSON schemas without network access')
    .argument('[operation]')
    .action((id?: string) => {
      if (id && !operationIds.includes(id as never))
        throw new UsageError(`Unknown operation; choose one of ${operationIds.join(', ')}`);
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
  for (const command of program.commands) addExamples(command);
  return program;
}

/** Runs the CLI and returns its exit code; failures print one JSON error object to stdout. */
export async function runCli(argv: string[], io: CliIO = defaultIO): Promise<number> {
  const program = createProgram(io, { jsonErrors: true });
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'exitCode' in error &&
      error.exitCode === 0 &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code.startsWith('commander.')
    )
      return 0;
    const { envelope, exitCode } = describeCliError(error, program, argv);
    io.out(JSON.stringify(envelope, null, 2));
    return exitCode;
  }
}
