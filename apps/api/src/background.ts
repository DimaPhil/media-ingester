/**
 * Runs a background task one pass at a time. A trigger during a pass schedules exactly one more
 * pass, so a completion that lands mid-pass is never missed and concurrent triggers coalesce.
 */
export function coalescedTask(task: () => Promise<unknown>, onError: () => void) {
  let running: Promise<void> | undefined;
  let again = false;
  const run = async () => {
    do {
      again = false;
      try {
        await task();
      } catch {
        onError();
      }
    } while (again);
    running = undefined;
  };
  return {
    trigger(): void {
      if (running) {
        again = true;
        return;
      }
      running = run();
    },
    /** Resolves once no pass is running. */
    async settled(): Promise<void> {
      while (running) await running;
    },
  };
}

/** Repeats a bounded batch while it reports a full batch, so a backlog clears in one pass. */
export function drainAll(batch: () => Promise<number>, batchSize: number) {
  return async () => {
    while ((await batch()) >= batchSize);
  };
}

export interface MaintenanceOptions {
  /** Releases server uploads whose jobs have all completed. */
  cleanUploads: () => Promise<unknown>;
  /** Deletes expired terminal job records. */
  expireJobs: () => Promise<unknown>;
  /** Deletes expired authentication entries. */
  pruneAuth: () => Promise<unknown>;
  /** Period of the fallback pass that runs every task. */
  intervalMs: number;
  onError: (task: 'uploads' | 'jobs' | 'auth') => void;
}

/**
 * Database housekeeping that stays quiet while the service is idle. Upload cleanup runs when the
 * workers go idle (startup, after jobs, after submissions and on their fallback poll). Every task
 * also runs at startup and on one rare shared timer, so a scale-to-zero database is not kept awake.
 */
export function startMaintenance(options: MaintenanceOptions) {
  const uploads = coalescedTask(options.cleanUploads, () => options.onError('uploads'));
  const jobs = coalescedTask(options.expireJobs, () => options.onError('jobs'));
  const auth = coalescedTask(options.pruneAuth, () => options.onError('auth'));
  const runAll = () => {
    uploads.trigger();
    jobs.trigger();
    auth.trigger();
  };
  runAll();
  const timer = setInterval(runAll, options.intervalMs);
  timer.unref?.();
  return {
    /** Workers found the queue empty; a completed job may have released an upload. */
    workersIdle: () => uploads.trigger(),
    async stop(): Promise<void> {
      clearInterval(timer);
      await Promise.all([uploads.settled(), jobs.settled(), auth.settled()]);
    },
  };
}
