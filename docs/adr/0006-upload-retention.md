# ADR 0006 · Release uploaded inputs after successful processing

**Status** Accepted

## Context

Uploaded files live on the server volume. Identical uploads by the same owner have a stable ID, so separate jobs can share one file. A failed job can be retried, and a worker can lose its lease before recording a result. Deleting a file directly from a worker's cleanup block could strand another job.

## Decision

Record cleanup eligibility in PostgreSQL in the same transaction as a successful fenced completion. A background task checks the owner and upload ID, serializes with publication and admission, and removes the upload only when no unfinished job references it. Keep failed jobs' inputs because the retry operation accepts failed jobs. Keep a fresh publication available for submission. Retry cleanup after a restart or filesystem failure.

## Consequences

Bytes can remain briefly after the client sees a completed result. The result stays readable in PostgreSQL after removal. A new job needs a new upload if the previous bytes have been released. Cleanup applies to future completions. Migration 002 creates coordination state without scanning historical completions for deletion. Local SDK files, remote originals, standalone uploads and stored results are outside the cleanup scope. All service processes sharing a volume must run the coordinated implementation. [Implementation](../../packages/adapters/src/upload-retention.ts) · [Integration tests](../../packages/adapters/test/postgres.test.ts)
