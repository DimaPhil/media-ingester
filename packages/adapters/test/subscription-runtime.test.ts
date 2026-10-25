import { mkdtemp, rm, realpath, mkdir, writeFile, symlink, stat, readFile } from 'node:fs/promises';
import { tmpdir, homedir, hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
const race = vi.hoisted(() => ({ releaseOnInspect: false }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      if (race.releaseOnInspect && String(args[0]).endsWith('.media-subscription.lock')) {
        race.releaseOnInspect = false;
        await fs.rm(args[0], { recursive: true, force: true });
      }
      return fs.lstat(...args);
    },
  };
});
import {
  subscriptionEnvironment,
  runSubscriptionProcess,
  withCredentialLock,
  validateCredentialHome,
} from '../src/subscription-runtime.js';
it('excludes API keys, custom providers, proxies, and inherited hooks from CLI environment', () => {
  const env = subscriptionEnvironment('codex', '/credentials', '/workspace');
  expect(env.CODEX_HOME).toBe('/credentials');
  expect(env.HOME).toBe('/workspace');
  expect(env).not.toHaveProperty('OPENAI_API_KEY');
  expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  expect(env).not.toHaveProperty('NODE_OPTIONS');
});
it('never overlaps concurrent credential holders', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'credential-test-')));
  const signal = new AbortController().signal;
  let release!: () => void;
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const first = withCredentialLock(home, signal, async () => {
    events.push('first-enter');
    entered();
    await gate;
    events.push('first-exit');
  });
  try {
    await firstEntered;
    const second = withCredentialLock(home, signal, async () => {
      events.push('second-enter');
    });
    await delay(150);
    expect(events).toEqual(['first-enter']);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-enter', 'first-exit', 'second-enter']);
  } finally {
    release();
    await first;
    await rm(home, { recursive: true, force: true });
  }
});
it('retries if the previous owner releases between collision and lock inspection', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'credential-test-')));
  try {
    await mkdir(join(home, '.media-subscription.lock'));
    race.releaseOnInspect = true;
    expect(
      await withCredentialLock(home, new AbortController().signal, async () => 'acquired'),
    ).toBe('acquired');
  } finally {
    race.releaseOnInspect = false;
    await rm(home, { recursive: true, force: true });
  }
});
it('aborting a waiter preserves the active holder lock', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'credential-test-')));
  const controller = new AbortController();
  try {
    await withCredentialLock(home, new AbortController().signal, async () => {
      const waiting = withCredentialLock(home, controller.signal, async () => {
        throw new Error('must not enter');
      });
      const assertion = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      await delay(30);
      controller.abort();
      await assertion;
      expect((await stat(join(home, '.media-subscription.lock'))).isDirectory()).toBe(true);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it('refuses a stale same-host lock without removing it', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'credential-test-')));
  const lock = join(home, '.media-subscription.lock');
  try {
    await mkdir(lock);
    // Deliberately beyond Linux/macOS PID ranges, while still a valid kill integer.
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: 2147483647, host: hostname() }),
    );
    await expect(
      withCredentialLock(home, new AbortController().signal, async () => 'unsafe'),
    ).rejects.toMatchObject({ code: 'subscription_lock_stale' });
    expect((await stat(lock)).isDirectory()).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it('rejects default credential homes and symbolic links', async () => {
  for (const home of [
    homedir(),
    join(homedir(), '.codex'),
    join(homedir(), '.claude'),
    'relative',
  ]) {
    await expect(validateCredentialHome(home)).rejects.toMatchObject({
      code: 'subscription_configuration',
    });
  }
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'credential-test-')));
  try {
    await mkdir(join(directory, 'target'));
    await symlink(join(directory, 'target'), join(directory, 'link'));
    await expect(validateCredentialHome(join(directory, 'link'))).rejects.toThrow('symlink');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('cancels an active subprocess', async () => {
  const controller = new AbortController();
  const running = runSubscriptionProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    cwd: tmpdir(),
    env: {},
    signal: controller.signal,
    timeoutMs: 3000,
  });
  const assertion = expect(running).rejects.toMatchObject({ code: 'subscription_aborted' });
  await delay(30);
  controller.abort();
  await assertion;
});
it.skipIf(process.platform === 'win32')(
  'kills a descendant that ignores TERM and has detached stdio before returning',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'process-group-test-'));
    const pidFile = join(directory, 'pid');
    let descendant: number | undefined;
    try {
      const childCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
      const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
      await expect(
        runSubscriptionProcess(process.execPath, ['-e', parentCode], {
          cwd: directory,
          env: {},
          signal: new AbortController().signal,
          timeoutMs: 500,
        }),
      ).rejects.toMatchObject({ code: 'subscription_timeout' });
      descendant = Number(await readFile(pidFile, 'utf8'));
      // Give the operating system a moment to reap the now-killed orphan.
      let alive = true;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          process.kill(descendant, 0);
        } catch {
          alive = false;
          break;
        }
        await delay(20);
      }
      expect(alive).toBe(false);
    } finally {
      if (descendant) {
        try {
          process.kill(descendant, 'SIGKILL');
        } catch {
          /* Already reaped. */
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
it.each([
  ['authentication required PRIVATE_FIXTURE', 'subscription_auth_required'],
  ['rate limit PRIVATE_FIXTURE', 'subscription_rate_limited'],
  ['unexpected PRIVATE_FIXTURE', 'subscription_failed'],
])('classifies failures while redacting child diagnostics: %s', async (diagnostic, code) => {
  const running = runSubscriptionProcess(
    process.execPath,
    ['-e', `process.stderr.write(${JSON.stringify(diagnostic)});process.exit(1)`],
    { cwd: tmpdir(), env: {}, signal: new AbortController().signal, timeoutMs: 3000 },
  );
  const error: unknown = await running.catch((reason) => reason);
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toContain('PRIVATE_FIXTURE');
});
it('bounds subprocess output and execution time without reflecting sensitive diagnostics', async () => {
  const options = {
    cwd: tmpdir(),
    env: {},
    signal: new AbortController().signal,
    timeoutMs: 3000,
    maxOutputBytes: 10,
  };
  await expect(
    runSubscriptionProcess(
      process.execPath,
      ['-e', 'process.stdout.write("secret".repeat(100))'],
      options,
    ),
  ).rejects.toThrow('output limit');
  await expect(
    runSubscriptionProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      ...options,
      timeoutMs: 30,
    }),
  ).rejects.toThrow('deadline');
});
it('serializes owners of a credential store and releases ownership on failure', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'credential-test-')));
  const signal = new AbortController().signal;
  try {
    await expect(
      withCredentialLock(home, signal, async () => {
        throw new Error('expected');
      }),
    ).rejects.toThrow('expected');
    expect(await withCredentialLock(home, signal, async () => 'released')).toBe('released');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
