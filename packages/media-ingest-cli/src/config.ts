import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

const cliConfigSchema = z.object({
  apiBaseUrl: z.string().url().optional(),
  apiToken: z.string().optional(),
  openaiApiKey: z.string().optional(),
  geminiApiKey: z.string().optional(),
  googleCloudProjectId: z.string().optional(),
  googleCloudServiceAccountJson: z.string().optional(),
  googleCloudLocation: z.string().optional(),
  mediaIngestConfigPath: z.string().optional(),
});

export type CliConfig = z.infer<typeof cliConfigSchema>;

export const defaultCliConfigPath = join(homedir(), '.media-ingest', 'env.json');

export async function loadCliConfig(path = defaultCliConfigPath): Promise<CliConfig> {
  try {
    const raw = await readFile(path, 'utf8');
    return cliConfigSchema.parse(JSON.parse(raw));
  } catch {
    return {};
  }
}
