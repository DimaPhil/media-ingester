import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Command } from 'commander';
import type { MediaClient } from '@media-ingest/client';
import {
  MAX_INLINE_MEDIA_BYTES,
  operations,
  requestSchema,
  type MediaRequest,
  type Source,
} from '@media-ingest/contracts';

export async function uploadFile(client: MediaClient, path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_INLINE_MEDIA_BYTES)
    throw new Error('Upload must be a regular file no larger than 32 MiB');
  const bytes = await readFile(path);
  if (bytes.length > MAX_INLINE_MEDIA_BYTES) throw new Error('Upload exceeds 32 MiB');
  return client.call('upload', { fileName: basename(path), data: bytes.toString('base64') });
}
export function inferSource(uri: string, kind?: string): Source {
  if (kind !== undefined) return { kind: kind as Source['kind'], uri };
  if (/^tg:\/\//iu.test(uri)) return { kind: 'telegram', uri };
  if (!/^https?:\/\//iu.test(uri)) return { kind: 'local_file', uri };
  const host = URL.parse(uri)?.hostname ?? '';
  if (/^(?:(?:www\.|m\.)?youtube\.com|youtu\.be)$/u.test(host)) return { kind: 'youtube', uri };
  if (/^(?:www\.)?instagram\.com$/u.test(host)) return { kind: 'instagram', uri };
  if (/^(?:www\.|mobile\.)?(?:x|twitter)\.com$/u.test(host)) return { kind: 'x', uri };
  if (['drive.google.com', 'docs.google.com'].includes(host)) return { kind: 'google_drive', uri };
  if (['t.me', 'telegram.me'].includes(host)) return { kind: 'telegram', uri };
  return { kind: 'http', uri };
}

export function registerMediaCommands(
  program: Command,
  client: () => Promise<MediaClient>,
  print: (value: unknown) => void,
) {
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
      .option('--force', 'Process from scratch instead of reusing a retained result')
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
            force?: boolean;
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
            ...(options.force ? { force: true } : {}),
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
}
