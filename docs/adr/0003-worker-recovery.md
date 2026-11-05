# ADR 0003 · Fence durable work and checkpoint each chunk

**Status** Accepted

Execution-record retention is amended by [ADR 0007](0007-retained-results-and-job-expiry.md). Lease fencing and checkpoint recovery remain required within that retention window.

## Context

A worker can crash after a provider accepts a request, or resume after a second worker claims the same job. Replaying all chunks wastes provider calls. Accepting late writes from the first worker can corrupt the result.

## Decision

Bind each idempotency key to the owner and normalized request, including the resolved model. Claim work with an expiring lease. Fence worker writes by token and expiry. Save the chunk plan and source fingerprint, checkpoint successful chunks individually, and aggregate only after all planned outputs are present. On recovery, materialize and fingerprint the source again before reusing checkpoints. [Worker lifecycle](../../packages/sdk/src/worker.ts) · [PostgreSQL implementation](../../packages/adapters/src/postgres.ts)

## Consequences

Repeated submissions can return the same job. An expired worker cannot finalize another worker's attempt. Provider calls are at least once because a crash can occur between the external response and the checkpoint. Any replacement repository must preserve these semantics under concurrency. Run persistence and E2E tests sequentially against disposable PostgreSQL. [Storage regression tests](../../packages/adapters/test/postgres.test.ts) · [Recovery E2E tests](../../test/e2e/service.test.ts)
