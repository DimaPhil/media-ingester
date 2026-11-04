import { copyFile, stat } from 'node:fs/promises';
import type { DownloadTarget } from './download.js';

export async function copyToTarget(
  origin: string,
  { path, maxBytes }: DownloadTarget,
): Promise<string> {
  if ((await stat(origin)).size > maxBytes)
    throw new Error('Media exceeds configured download limit');
  await copyFile(origin, path);
  return path;
}
