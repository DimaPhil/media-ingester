import { CommanderError, type Command } from 'commander';
import { MediaClientError } from '@media-ingest/client';
import type { NextStep } from '@media-ingest/contracts';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** Invalid local input or arguments: exit code 2, like an unknown flag. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export interface ErrorEnvelope {
  error: { code: string; message: string; details?: Record<string, string | number> };
  help?: string[];
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Renders a suggested catalog call as a `media` command with its reason as a shell comment. */
export function renderStep(step: NextStep): string {
  const keys = Object.keys(step.input);
  const command =
    keys.length === 1 && keys[0] === 'id' && typeof step.input.id === 'string'
      ? `media ${step.operation} ${step.input.id}`
      : `media ${step.operation} --input ${quote(JSON.stringify(step.input))}`;
  const wait = step.pollAfterSeconds ? `after ${step.pollAfterSeconds}s: ` : '';
  return `${command}  # ${wait}${step.reason}`;
}

/** A single job view with suggested steps gains a top-level `help` list of commands. */
export function withHelp(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as { id?: unknown; status?: unknown; nextSteps?: NextStep[] };
  if (typeof record.id !== 'string' || typeof record.status !== 'string') return value;
  const error = (value as { error?: { nextSteps?: NextStep[] } | null }).error;
  const steps = [...(record.nextSteps ?? []), ...(error?.nextSteps ?? [])];
  return steps.length ? { ...value, help: steps.map(renderStep) } : value;
}

/** The subcommand named on the command line, if any, for usage hints. */
function invokedCommand(program: Command, argv: string[]): Command | undefined {
  for (const word of argv.slice(2)) {
    if (word.startsWith('-')) continue;
    return program.commands.find((command) => command.name() === word);
  }
  return undefined;
}

function usage(error: CommanderError, program: Command, argv: string[]): ErrorEnvelope {
  const command = invokedCommand(program, argv);
  const message =
    error.code === 'commander.help'
      ? 'A command is required'
      : error.message
          .replace(/^error: /u, '')
          .replaceAll('\n', ' ')
          .trim();
  if (!command)
    return {
      error: { code: 'usage_error', message },
      help: [
        'media --help',
        `Commands: ${program.commands
          .filter((entry) => entry.name() !== '__complete')
          .map((entry) => entry.name())
          .join(', ')}`,
      ],
    };
  const flags = command.options.map((option) => option.flags);
  return {
    error: { code: 'usage_error', message, details: { command: command.name() } },
    help: [
      `media ${command.name()} --help`,
      `Valid options: ${[...flags, '-h, --help'].join(', ')}`,
    ],
  };
}

const clientHelp: Record<string, (operation?: string) => string[]> = {
  contract_mismatch: () => [
    'media info  # compare the server version with media --version, then install the matching CLI',
  ],
  network_error: () => ['media info  # check MEDIA_API_URL, network and server availability'],
  invalid_input: (operation) => [`media schema ${operation ?? '<operation>'}`],
  not_found: () => ['media list  # find the job ID'],
};

/**
 * Converts a failure into the JSON written to stdout and the exit code: 2 for usage and input
 * errors, 1 for everything else.
 */
export function describeCliError(
  error: unknown,
  program: Command,
  argv: string[],
): { envelope: ErrorEnvelope; exitCode: number } {
  const operation = invokedCommand(program, argv)?.name();
  if (error instanceof CommanderError)
    return { envelope: usage(error, program, argv), exitCode: 2 };
  if (error instanceof Error && error.name === 'ZodError' && 'issues' in error)
    return {
      envelope: {
        error: {
          code: 'invalid_input',
          message: (error.issues as Array<{ path: PropertyKey[]; message: string }>)
            .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
            .join('; '),
        },
        help: [operation ? `media ${operation} --help` : 'media --help'],
      },
      exitCode: 2,
    };
  if (error instanceof UsageError)
    return {
      envelope: {
        error: { code: 'usage_error', message: error.message },
        help: [operation ? `media ${operation} --help` : 'media --help'],
      },
      exitCode: 2,
    };
  if (error instanceof MediaClientError) {
    const code = error.code ?? 'client_error';
    const help =
      error.status === 401
        ? ['media setup --url <url> --token-stdin  # or set MEDIA_API_TOKEN']
        : code === 'conflict'
          ? [
              `media get ${argv.find((word) => uuid.test(word)) ?? '<id>'}  # read the current state`,
            ]
          : (clientHelp[code]?.(operation) ?? []);
    return {
      envelope: {
        error: {
          code,
          message: error.message,
          ...(error.status ? { details: { httpStatus: error.status } } : {}),
        },
        ...(help.length ? { help } : {}),
      },
      exitCode: code === 'invalid_input' ? 2 : 1,
    };
  }
  return {
    envelope: {
      error: {
        code: 'command_failed',
        message: error instanceof Error ? error.message : 'Command failed',
      },
    },
    exitCode: 1,
  };
}

/** Examples shown after each command's options; JSON samples are checked against the catalog. */
export const commandExamples: Record<string, string[]> = {
  submit: [
    `media submit --input '{"request":{"kind":"transcription","source":{"kind":"http","uri":"https://example.com/audio.mp3"},"provider":"openai"},"idempotencyKey":"meeting-1"}'`,
    'media submit --file request.json',
  ],
  get: [
    'media get 00000000-0000-4000-8000-000000000000',
    `media get --input '{"id":"00000000-0000-4000-8000-000000000000"}'`,
  ],
  list: [`media list --input '{"limit":10,"status":"failed"}'`, 'media list'],
  retry: ['media retry 00000000-0000-4000-8000-000000000000'],
  history: ['media history', `media history --input '{"limit":5,"mediaId":"youtube:abc"}'`],
  result: ['media result 00000000-0000-4000-8000-000000000000'],
  resolve: [`media resolve --input '{"source":{"kind":"youtube","uri":"https://youtu.be/abc"}}'`],
  upload: ['media upload ./recording.mp3'],
  download: [
    `media download --input '{"source":{"kind":"http","uri":"https://example.com/audio.mp3"}}'`,
  ],
  info: ['media info'],
  transcribe: [
    'media transcribe ./recording.mp3 --provider openai',
    'media transcribe https://youtu.be/abc --provider google-gemini --input-language ru',
    'media transcribe ./meeting.wav --provider codex --idempotency-key meeting-1',
  ],
  understand: [
    "media understand ./demo.mp4 --prompt 'Summarize the demonstration'",
    "media understand https://youtu.be/abc --provider codex --prompt 'List the steps' --force",
  ],
  setup: ['media setup --url https://media.example.com --token-stdin < token.txt'],
  schema: ['media schema submit', 'media schema'],
  completion: ['eval "$(media completion zsh)"'],
};

export function addExamples(command: Command): void {
  const examples = commandExamples[command.name()];
  if (examples)
    command.addHelpText('after', `\nExamples:\n${examples.map((line) => `  ${line}`).join('\n')}`);
}
