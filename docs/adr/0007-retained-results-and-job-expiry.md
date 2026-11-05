# ADR 0007 · Keep processed outputs and expire terminal job records

**Status** Accepted. Amends the retention aspect of [ADR 0003](0003-worker-recovery.md).

## Context

Job JSON currently contains both execution checkpoints and the final output. Deleting it would also delete the processing history. The owner needs successful outputs and media metadata retained for an admin dashboard, while execution records should expire after one month.

## Decision

Store each successful output in owner-scoped `processed_media`, keyed by its original job ID, in the same lease-fenced transaction as completion. Preserve the original request, native media ID when available, content fingerprint, resolved source metadata, media inspection and completion time. Historical completed jobs are backfilled from their existing data without refetching media.

Set an indexed `expires_at` on completed and failed jobs to 30 days after their terminal transition. A bounded PostgreSQL janitor runs at API startup and every minute. It removes up to 100 terminal records per pass and requires a durable result before deleting a completed job. Queued/running jobs are excluded. Retry clears expiry until the next terminal transition. Preserve an expired failed job's upload as a standalone input under the existing upload lock.

Expose retained history and results through the shared REST/CLI/MCP operation catalog. The admin page uses those operations and the existing bearer authentication. Its public shell contains no private data. Owner tokens stay in tab memory. Uploaded bytes retain their existing cleanup policy; the dashboard presents source links, metadata and outputs.

## Consequences

Output history survives execution-row deletion and has no automatic expiry. Checkpoints, leases and idempotency keys are retained only for the job's lifetime. After expiry, use the result/history operations with the original job ID; retries require a new job. Old records may lack resolved filenames and inspection metadata because those were never saved. Stop older writers before migration 003, then start the new API after migration succeeds.

[Migration](../../packages/adapters/migrations/003_processed_media.sql) · [Job cleanup](../../packages/adapters/src/job-retention.ts) · [Database tests](../../packages/adapters/test/postgres.test.ts)
