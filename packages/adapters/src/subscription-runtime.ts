import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaError } from '@media-ingest/sdk';

export type SubscriptionProvider = 'codex' | 'claude-code';

export async function validateCredentialHome(home: string): Promise<string> {
  if (
    !isAbsolute(home) ||
    [homedir(), join(homedir(), '.codex'), join(homedir(), '.claude')].includes(resolve(home))
  ) {
    throw new MediaError(
      'subscription_configuration',
      'A dedicated absolute CLI credential directory is required',
    );
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new MediaError(
      'subscription_configuration',
      'CLI credential directory must not be a symlink',
    );
  const canonical = await realpath(home);
  if (canonical !== resolve(home))
    throw new MediaError(
      'subscription_configuration',
      'CLI credential directory must use its canonical path',
    );
  await access(home, constants.R_OK | constants.W_OK);
  return canonical;
}

/** Native CLIs keep auth in their dedicated stores; inherited API/proxy/tool overrides are absent. */
export function subscriptionEnvironment(
  provider: SubscriptionProvider,
  credentialHome: string,
  workspace: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    HOME: workspace,
    TMPDIR: workspace,
    XDG_CONFIG_HOME: join(workspace, '.config'),
    XDG_CACHE_HOME: join(workspace, '.cache'),
    NO_COLOR: '1',
  };
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
  if (provider === 'codex') env.CODEX_HOME = credentialHome;
  else {
    env.CLAUDE_CONFIG_DIR = credentialHome;
    env.CLAUDE_CODE_SAFE_MODE = '1';
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  }
  return env;
}

/** Cross-process exclusive ownership; crashed locks require explicit operator removal, never unsafe stealing. */
export async function withCredentialLock<T>(
  home: string,
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  const canonical = await validateCredentialHome(home);
  const lock = join(canonical, '.media-subscription.lock');
  const waitDeadline = Date.now() + 600_000;
  for (;;) {
    signal.throwIfAborted();
    if (Date.now() >= waitDeadline)
      throw new MediaError(
        'subscription_lock_timeout',
        'Credential store remained busy for ten minutes',
        true,
      );
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      const info = await lstat(lock).catch((probe: unknown) => {
        if (probe instanceof Error && 'code' in probe && probe.code === 'ENOENT') return null;
        throw probe;
      });
      // The previous holder can release between mkdir(EEXIST) and inspection.
      if (!info) continue;
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new MediaError('subscription_lock_invalid', 'Credential lock is not a directory');
      let owner: { pid?: number; host?: string } | undefined;
      try {
        owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
      } catch {
        /* Creator may still be writing the ownership record. */
      }
      if (owner?.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
        try {
          process.kill(owner.pid!, 0);
        } catch (probe) {
          if (probe instanceof Error && 'code' in probe && probe.code === 'ESRCH')
            throw new MediaError(
              'subscription_lock_stale',
              'A previous CLI process left a credential lock; verify it stopped before removing .media-subscription.lock',
            );
        }
      }
      await delay(100, undefined, { signal });
    }
  }
  try {
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname() }),
      { flag: 'wx', mode: 0o600 },
    );
    signal.throwIfAborted();
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export interface SubscriptionProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  input?: string;
  maxOutputBytes?: number;
}

/** Failures never reflect stdout/stderr, which can contain private prompts or CLI diagnostics. */
export async function runSubscriptionProcess(
  binary: string,
  args: string[],
  options: SubscriptionProcessOptions,
): Promise<{ stdout: string; stderr: string }> {
  options.signal.throwIfAborted();
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    throw new MediaError(
      'subscription_configuration',
      'A positive subprocess deadline is required',
    );
  if (Buffer.byteLength(options.input ?? '') > 10 * 1024 * 1024)
    throw new MediaError('subscription_input_too_large', 'Prepared CLI context exceeds 10 MiB');
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        /* The process may already have exited. */
      }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
      killTimer.unref();
    };
    const aborted = () =>
      stop(new MediaError('subscription_aborted', 'Subscription operation was cancelled', true));
    const deadline = setTimeout(
      () =>
        stop(
          new MediaError('subscription_timeout', 'Subscription CLI exceeded its deadline', true),
        ),
      options.timeoutMs,
    );
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 4 * 1024 * 1024))
        stop(
          new MediaError(
            'subscription_output_too_large',
            'Subscription CLI exceeded its output limit',
          ),
        );
      else target.push(chunk);
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    options.signal.addEventListener('abort', aborted, { once: true });
    if (options.signal.aborted) aborted();
    child.on('error', () => {
      failure ??= new MediaError(
        'subscription_unavailable',
        'Subscription CLI could not be started',
      );
    });
    child.stdin.on('error', () => {
      /* Early CLI exit closes stdin; close event owns the error. */
    });
    child.on('close', (code) => {
      // Closing the leader's pipes does not prove its detached descendants stopped.
      // Kill the entire group before returning/releasing its credential lock.
      if (failure) kill('SIGKILL');
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener('abort', aborted);
      if (failure) return reject(failure);
      if (code !== 0) {
        const diagnostic =
          Buffer.concat(stderr).toString('utf8') + Buffer.concat(stdout).toString('utf8');
        const auth = /not logged in|login required|authentication|unauthorized|sign in/i.test(
          diagnostic,
        );
        const limited = /rate.limit|usage.limit|quota|too many requests/i.test(diagnostic);
        return reject(
          new MediaError(
            auth
              ? 'subscription_auth_required'
              : limited
                ? 'subscription_rate_limited'
                : 'subscription_failed',
            auth
              ? 'Native CLI login is required'
              : limited
                ? 'Subscription usage limit reached'
                : 'Subscription CLI failed',
            limited,
          ),
        );
      }
      resolveResult({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(options.input ?? '');
  });
}
