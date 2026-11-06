# ADR 0008 · Reuse retained results for equivalent requests

**Status** Accepted. Builds on [ADR 0007](0007-retained-results-and-job-expiry.md).

## Context

Every submission downloaded the source again and repeated all provider calls, even when the same owner had already processed the same media with the same settings. Provider calls cost money or subscription quota, and site downloads can be throttled. During prompt development the owner also needs a deterministic way to bypass any saved output.

## Decision

By default the worker reuses the newest retained `processed_media` output for the same owner and an equivalent request. Equivalence covers kind, provider, resolved model, input language and target language. Understanding also requires the exact prompt; the optional transcription prompt hint is ignored. Results never cross owners.

Media identity is checked in two tiers. After `resolve`, a non-empty `metadata.mediaId` matches results with the same media ID, source kind and `downloadProvider`, so a hit skips the download. After `materialize`, the content fingerprint matches results from any source, including re-uploads and mirrors with identical bytes. Repositories return a bounded, newest-first candidate list; the SDK owns the equivalence policy.

A hit completes the job through a lease-fenced `completeFromCache` write. The job receives the retained output and `cachedFrom`, the reused result ID. It records no chunk checkpoints and adds no history row. Upload cleanup runs as for normal completion.

`request.force: true` skips both lookups and processes from scratch. Its new output becomes the newest retained result, so later unforced requests reuse it. Because `force` is part of the request, it is included in idempotency matching. The CLI exposes it as `--force`; MCP and REST receive it through the shared request schema.

## Consequences

Reuse is indefinite: retained outputs do not expire. Site IDs are trusted as stable identities, so a Google Drive file replaced under the same ID, or any changed upstream content behind a stable ID, returns the earlier output until a forced run. A changed provider default model naturally misses. Concurrent identical jobs may both process; reuse is an optimization, not deduplication. Only the newest 100 results per identity are scanned, and an older equivalent match simply causes a fresh run. Cached jobs expire after 30 days like other jobs; their output remains available through `result <cachedFrom>`.

Migration 004 adds an owner/fingerprint index. Site-ID lookups use the existing media-ID index.

[Policy](../../packages/sdk/src/cache.ts) · [Worker](../../packages/sdk/src/worker.ts) · [Repository](../../packages/adapters/src/postgres.ts) · [Migration](../../packages/adapters/migrations/004_result_reuse.sql) · [SDK tests](../../packages/sdk/test/sdk.test.ts) · [Database tests](../../packages/adapters/test/postgres.test.ts) · [E2E](../../test/e2e/service.test.ts)
