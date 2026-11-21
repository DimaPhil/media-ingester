import { MediaError } from './errors.js';

/**
 * In-process wake-up for idle workers. A caller records `version` before looking for work and
 * passes it to `wait`, so a notification that lands between an empty claim and the wait is kept.
 */
export class WorkSignal {
  private generation = 0;
  private readonly waiters = new Set<() => void>();

  get version(): number {
    return this.generation;
  }

  notify(): void {
    this.generation++;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  /** Resolves after a notification newer than `since`, after `timeoutMs`, or on abort. */
  wait(since: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.generation !== since || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        this.waiters.delete(done);
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
      if (Number.isFinite(timeoutMs)) timer = setTimeout(done, timeoutMs);
    });
  }
}

export interface WorkerLoopOptions {
  /** Number of concurrent worker loops. */
  workers: number;
  /**
   * Fallback claim period while idle. Submissions and retries through this SDK wake workers
   * immediately; the period only recovers expired leases and work queued by other processes.
   */
  idlePollMs: number;
  /** Stops the loops; running jobs are aborted and their leases left to expire. */
  signal: AbortSignal;
  /** Called whenever a worker finds no claimable job, including at startup and after each poll. */
  onIdle?: () => void;
  /** Called when claiming or recording a job fails. The loop backs off and continues. */
  onError?: (error: unknown) => void;
}

const FIRST_ERROR_DELAY_MS = 1000;
const MAX_ERROR_DELAY_MS = 60_000;

/** Drains the queue, then sleeps until woken or until the shared fallback poll fires. */
export async function runWorkerLoops(
  runNext: (signal: AbortSignal) => Promise<boolean>,
  wake: WorkSignal,
  options: WorkerLoopOptions,
  /** Lease length. A job left running by a stopped process becomes claimable once it expires. */
  leaseMs?: number,
): Promise<void> {
  const { workers, idlePollMs, signal } = options;
  if (!Number.isInteger(workers) || workers < 1 || !Number.isFinite(idlePollMs) || idlePollMs <= 0)
    throw new MediaError('invalid_configuration', 'Invalid worker count or idle poll interval');
  // One shared timer keeps every worker's fallback claim in the same database wake-up.
  const poll = setInterval(() => wake.notify(), idlePollMs);
  poll.unref?.();
  // After a restart, a job interrupted by the previous process still holds an unexpired lease,
  // so the startup claim misses it. Look once more just after any such lease must have expired.
  const restart =
    leaseMs === undefined ? undefined : setTimeout(() => wake.notify(), leaseMs + 1000);
  restart?.unref?.();
  const stop = () => {
    clearInterval(poll);
    clearTimeout(restart);
  };
  signal.addEventListener('abort', stop, { once: true });
  const maxErrorDelayMs = Math.min(MAX_ERROR_DELAY_MS, idlePollMs);
  const loop = async () => {
    let failures = 0;
    while (!signal.aborted) {
      const seen = wake.version;
      try {
        if (await runNext(signal)) {
          failures = 0;
          continue;
        }
        failures = 0;
        notify(options.onIdle);
        await wake.wait(seen, Infinity, signal);
      } catch (error) {
        if (signal.aborted) break;
        notify(options.onError, error);
        const delay = Math.min(FIRST_ERROR_DELAY_MS * 2 ** failures, maxErrorDelayMs);
        failures++;
        await wake.wait(wake.version, delay, signal);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: workers }, loop));
  } finally {
    stop();
    signal.removeEventListener('abort', stop);
  }
}

function notify<T extends unknown[]>(callback: ((...args: T) => void) | undefined, ...args: T) {
  try {
    callback?.(...args);
  } catch {
    /* Host callbacks must not stop a worker loop. */
  }
}
