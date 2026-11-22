# Embedded SDK

The SDK runs the same lifecycle as the API without HTTP. Supply source, media, and provider adapters; omit `repository` for an isolated in-memory store, or reuse `PostgresJobRepository` from the adapters package. Each adapter is independently replaceable. Node crypto supplies IDs and request hashes; the SDK does not import filesystem, vendor SDKs, SQL, or an HTTP server.

```ts
import { MediaSdk } from '@media-ingest/sdk';

const sdk = new MediaSdk({ sources, media, provider, repository });
const job = await sdk.submit(
  'owner',
  {
    kind: 'transcription',
    source: { kind: 'local_file', uri: '/data/interview.mp4' },
    provider: 'openai',
  },
  'interview-2026-10-24',
);
await sdk.runNext();
const result = await sdk.get('owner', job.id);
```

`runNext(signal)` claims and processes one job and returns whether work was found. A host owns its shutdown signal. `runWorkers({ workers, idlePollMs, signal, onIdle, onError })` runs worker loops that drain the queue and then sleep without repository queries until `submit`, `retry` or `wake()` on the same instance, or until the shared `idlePollMs` fallback; use it when submissions and workers share a process, or call `runNext` from your own loop. Stopping aborts adapters and leaves the lease to expire, allowing another worker to recover. The repository must implement every atomicity and fencing rule in `src/ports.ts`; the in-memory implementation is a reference, not durable production storage.

Jobs pin the selected provider model on submission. Idempotency keys are scoped to the owner and conflict if reused with a different normalized request. Workers rematerialize sources on every attempt, verify a content fingerprint, and reuse only successful chunk checkpoints. With a media `loudness` profile, chunk boundaries fall in pauses; where none exists, neighbors overlap and keep ranges plus transcript stitching prevent duplicated or cut words. Timestamps are offset into the original media timeline. Failed jobs require explicit `retry`. Provider calls may repeat after process failure between an external response and its checkpoint; exactly-once provider billing is not guaranteed.

Job views from `submit`, `get`, `list` and `retry` include a `stage` and computed `nextSteps`: a `get` poll step while active, and in `error.nextSteps` after a failure, retry, an alternative provider or a source check. Throw `MediaError(code, message, retryable, details)` from adapters with flat diagnostic details; never put provider bodies, tokens or URLs there. The worker adds stage, attempt and chunk context and records any other error as `processing_failed` with its class name. `onProcessingError(jobId, error, failure)` receives the recorded failure. Repositories may implement the optional fenced `saveStage`; providers may implement `alternatives(request)` to name providers suggested after a provider-specific failure. See [ADR 0014](../../docs/adr/0014-agent-facing-errors-and-progress.md).

Artifacts are opaque URIs plus filenames and stable fingerprints. Providers return relative timestamps within their chunk. Adapters must honor `AbortSignal`; cleanup must affect only the supplied job attempt. Media cleanup failure does not erase an already persisted result and is delivered to `onCleanupError`.

Built-in repositories save successful outputs independently of job execution state. `sdk.history(ownerId, { limit, before, mediaId })` returns cursor-paginated summaries and `sdk.getResult(ownerId, originalJobId)` returns a saved output. The worker supplies resolved source metadata, inspection and available size when completing a job. Custom repositories can implement the optional history methods; processing with an older repository still works, while history calls report `unsupported_history`.

Workers reuse the newest retained output for the same owner, media (resolved `metadata.mediaId` before download, then content fingerprint) and an equivalent request; see `resultCacheKey`. Set `request.force` to process from scratch. Repositories enable reuse by implementing the optional `findResults` and `completeFromCache` methods; without them every job processes normally.

### Replace one built-in provider

The registries and concrete classes are exported by `@media-ingest/adapters`. Pass the same registries to `MediaSdk` after overriding a specific source or model. A source override implements `SourceAdapter`. A model registry override implements `NodeProviderAdapter`, including input format selection and translation, so the override controls every phase for that provider ID.

```ts
import { NodeFiles, NodeProviders, NodeSources } from '@media-ingest/adapters';
import type { NodeProviderAdapter } from '@media-ingest/adapters';
import type { SourceAdapter } from '@media-ingest/sdk';

function makeAdapters(workRoot: string, instagram: SourceAdapter, gemini: NodeProviderAdapter) {
  const files = new NodeFiles({ workRoot });
  return {
    sources: new NodeSources({ files, overrides: { instagram } }),
    provider: new NodeProviders({ overrides: { 'google-gemini': gemini } }),
  };
}
```

See the [class hierarchy and extension points](../../docs/architecture.md#changing-a-source).
