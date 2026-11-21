import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coalescedTask, drainAll, startMaintenance } from '../src/background.js';

const HOUR = 60 * 60_000;

async function settle() {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

describe('background tasks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs one pass at a time and repeats once for triggers during a pass', async () => {
    let release: () => void = () => {};
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const onError = vi.fn();
    const runner = coalescedTask(task, onError);
    runner.trigger();
    runner.trigger();
    runner.trigger();
    expect(task).toHaveBeenCalledTimes(1);
    release();
    await settle();
    expect(task).toHaveBeenCalledTimes(2);
    release();
    await runner.settled();
    expect(task).toHaveBeenCalledTimes(2);
    task.mockRejectedValueOnce(new Error('disk'));
    runner.trigger();
    await runner.settled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('repeats a bounded batch until it is no longer full', async () => {
    const batch = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(32)
      .mockResolvedValueOnce(32)
      .mockResolvedValueOnce(5);
    await drainAll(batch, 32)();
    expect(batch).toHaveBeenCalledTimes(3);
  });

  it('keeps housekeeping off the database between rare passes', async () => {
    const cleanUploads = vi.fn(async () => 0);
    const expireJobs = vi.fn(async () => 0);
    const pruneAuth = vi.fn(async () => {});
    const onError = vi.fn();
    const maintenance = startMaintenance({
      cleanUploads,
      expireJobs,
      pruneAuth,
      intervalMs: HOUR,
      onError,
    });
    await settle();
    expect([cleanUploads, expireJobs, pruneAuth].map((task) => task.mock.calls.length)).toEqual([
      1, 1, 1,
    ]);
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect([cleanUploads, expireJobs, pruneAuth].map((task) => task.mock.calls.length)).toEqual([
      1, 1, 1,
    ]);
    // Idle workers only release uploads; expiry and auth pruning wait for the timer.
    maintenance.workersIdle();
    await settle();
    expect([cleanUploads, expireJobs, pruneAuth].map((task) => task.mock.calls.length)).toEqual([
      2, 1, 1,
    ]);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect([cleanUploads, expireJobs, pruneAuth].map((task) => task.mock.calls.length)).toEqual([
      3, 2, 2,
    ]);
    expireJobs.mockRejectedValueOnce(new Error('db'));
    pruneAuth.mockRejectedValueOnce(new Error('db'));
    cleanUploads.mockRejectedValueOnce(new Error('disk'));
    await vi.advanceTimersByTimeAsync(HOUR);
    await settle();
    expect(onError.mock.calls.map(([task]) => task).sort()).toEqual(['auth', 'jobs', 'uploads']);
    await maintenance.stop();
    await vi.advanceTimersByTimeAsync(10 * HOUR);
    expect(expireJobs).toHaveBeenCalledTimes(3);
  });
});
