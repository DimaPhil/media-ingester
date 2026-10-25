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

`runNext(signal)` claims and processes one job and returns whether work was found. A host owns its polling loop and shutdown signal. Stopping aborts adapters and leaves the lease to expire, allowing another worker to recover. The repository must implement every atomicity and fencing rule in `src/ports.ts`; the in-memory implementation is a reference, not durable production storage.

Jobs pin the selected provider model on submission. Idempotency keys are scoped to the owner and conflict if reused with a different normalized request. Workers rematerialize sources on every attempt, verify a content fingerprint, and reuse only successful chunk checkpoints. Non-overlapping chunks avoid duplicate transcript windows; timestamps are offset into the original media timeline. Failed jobs require explicit `retry`. Provider calls may repeat after process failure between an external response and its checkpoint; exactly-once provider billing is not guaranteed.

Artifacts are opaque URIs plus filenames and stable fingerprints. Providers return relative timestamps within their chunk. Adapters must honor `AbortSignal`; cleanup must affect only the supplied job attempt. Media cleanup failure does not erase an already persisted result and is delivered to `onCleanupError`.
