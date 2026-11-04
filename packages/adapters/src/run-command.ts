import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function runCommand(
  binary: string,
  args: string[],
  signal: AbortSignal,
  timeout = 15 * 60 * 1000,
): Promise<string> {
  const result = await execute(binary, args, {
    signal,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.stdout;
}
