# ADR 0013 · Wake workers in process and keep the idle database quiet

**Status** Accepted. Supersedes the janitor schedule in [ADR 0007](0007-retained-results-and-job-expiry.md) and the cleanup timing implied by [ADR 0006](0006-upload-retention.md); changes how quickly [ADR 0003](0003-worker-recovery.md) recovery claims an expired lease.

## Context

The production database is a Neon Free-plan compute. Neon suspends a compute only after five minutes without queries, and the Free plan cannot change that delay. Each idle worker claimed every second, upload cleanup queried every 5 seconds and terminal-job expiry every minute. The compute therefore never suspended: Neon reported it active for the whole project lifetime, about 108 CU-hours at the 0.25 CU minimum, exhausting the monthly 100 CU-hour allowance although the service was mostly idle. `LISTEN/NOTIFY` would need a long-lived direct connection and keep the compute busy as well.

## Decision

API and workers share one process, and every submission and retry passes through the SDK. `MediaSdk.submit`, `retry` and `wake` notify an in-process signal. `MediaSdk.runWorkers` drains claimable jobs, then sleeps without touching the repository until notified or until one shared fallback timer fires (`MEDIA_WORKER_IDLE_POLL_MS`, default 30 minutes). All loops claim at startup and once more just after a lease held by the previous process must have expired (lease length plus one second), so a deploy or restart during a job resumes it within about a minute. The signal carries a version, so a notification that arrives between an empty claim and the wait is not lost. An attempt that loses its lease wakes the loops again just after the lease expires. Repository errors back off from one second up to one minute. Lease heartbeats and checkpoints while a job runs are unchanged.

Upload cleanup runs whenever the workers find the queue empty: at startup, after the last job of a burst, after each submission (an idempotent replay can republish an already completed upload) and on the fallback poll. Terminal-job expiry, auth pruning and upload cleanup also run at startup and on one shared maintenance timer (`MEDIA_MAINTENANCE_INTERVAL_MS`, default one hour). Each task runs one pass at a time; a trigger during a pass schedules one more pass, and bounded batches repeat while full. Retention rules are unchanged.

## Consequences

An idle service queries the database only on the fallback poll and maintenance timer, which start together, so the compute wakes about twice an hour and can suspend in between. Submissions still start immediately. A job queued by another process, or one whose lease expired while its own process stayed alive without noticing, waits up to the fallback interval. A job interrupted by a crash or deploy resumes after restart once its lease expires. A failed upload removal is retried on the next idle pass or maintenance run rather than within 30 seconds. Terminal records may outlive their 30-day expiry by up to the maintenance interval. Several processes sharing one database must each poll; lowering the poll interval below five minutes keeps a Neon compute awake. An open, visible admin page still refreshes every 4 seconds and keeps the compute awake while it is shown.

[Worker loops](../../packages/sdk/src/workers.ts) · [SDK wake-up](../../packages/sdk/src/sdk.ts) · [Maintenance tasks](../../apps/api/src/background.ts) · [Server wiring](../../apps/api/src/main.ts) · [Loop tests](../../packages/sdk/test/workers.test.ts) · [Maintenance tests](../../apps/api/test/background.test.ts)
