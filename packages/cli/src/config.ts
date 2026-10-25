import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateBaseUrl } from '@media-ingest/client';

export interface CliConfig {
  baseUrl: string;
  token: string;
}
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), '.config'),
    'media',
    'config.json',
  );
}
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<CliConfig> {
  let saved: Partial<CliConfig> = {};
  try {
    saved = JSON.parse(await readFile(configPath(env), 'utf8')) as Partial<CliConfig>;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
      throw new Error('Cannot read media configuration; repair it with media setup');
  }
  const baseUrl = env.MEDIA_API_URL ?? saved.baseUrl;
  const token = env.MEDIA_API_TOKEN ?? saved.token;
  if (typeof baseUrl !== 'string' || typeof token !== 'string' || !token.trim())
    throw new Error(
      'Set MEDIA_API_URL and MEDIA_API_TOKEN, or run media setup --url <URL> --token-stdin',
    );
  return { baseUrl: validateBaseUrl(baseUrl), token };
}
export async function saveConfig(
  config: CliConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const path = configPath(env);
  const baseUrl = validateBaseUrl(config.baseUrl);
  if (!config.token.trim() || /[\r\n]/u.test(config.token))
    throw new Error('Token must be nonempty and contain no line breaks');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error('Refusing to replace a symlinked configuration');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ baseUrl, token: config.token }, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporary, path);
  await chmod(path, 0o600);
  return path;
}
