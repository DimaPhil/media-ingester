import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { MediaClient } from '@media-ingest/client';
import { operations, operationIds } from '@media-ingest/contracts';
import { uploadFile } from './media-commands.js';

type JsonOptions = { input?: string; file?: string };

async function inputJSON(
  options: JsonOptions,
  stdin: () => Promise<string>,
): Promise<Record<string, unknown>> {
  if (options.input && options.file) throw new Error('Use either --input or --file');
  const text =
    options.input ??
    (options.file === '-'
      ? await stdin()
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
export function registerCatalogCommands(
  program: Command,
  client: () => Promise<MediaClient>,
  print: (value: unknown) => void,
  stdin: () => Promise<string>,
) {
  for (const id of operationIds) {
    const operation = operations[id];
    const command = program
      .command(id)
      .description(operation.description)
      .option('--input <json>', 'JSON request object')
      .option('--file <path>', 'Read JSON request from file; - reads stdin');
    const hasId = operation.path.includes(':id');
    if (hasId) command.argument('[id]', 'Job UUID');
    if (id === 'upload') command.argument('[path]', 'Local file to upload');
    command.action(async (...args: unknown[]) => {
      const positional = hasId || id === 'upload';
      const value = positional ? (args[0] as string | undefined) : undefined;
      const options = args[positional ? 1 : 0] as JsonOptions;
      if (id === 'upload' && value) {
        if (options.input || options.file)
          throw new Error('Use upload <path> or a JSON request, not both');
        print(await uploadFile(await client(), value));
        return;
      }
      const input = await inputJSON(options, stdin);
      if (value) {
        if (input.id !== undefined && input.id !== value)
          throw new Error('Positional ID conflicts with JSON ID');
        input.id = value;
      }
      // Runtime catalog validation remains authoritative, including newly added commands.
      print(await (await client()).call(id, input as never));
    });
  }
}
