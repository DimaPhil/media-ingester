# Architecture and invariants

This page records the package boundaries and invariants future changes must preserve.

```mermaid
flowchart LR
  CLI[media CLI] --> Client[HTTP client]
  Client --> REST[REST routes]
  Agent[AI agent] --> MCP[MCP tools]
  REST --> Dispatch[Authenticated catalog dispatcher]
  MCP --> Dispatch
  Dispatch --> SDK[Media SDK]
  Embed[Embedding application] --> SDK
  SDK --> Ports[Repository / sources / media / providers]
  Ports --> PG[(PostgreSQL)]
  Ports --> Files[(Media volume)]
  Ports --> Vendors[Model providers]
  Contract[Operation catalog] -.-> CLI
  Contract -.-> REST
  Contract -.-> MCP
```

## Ownership

Contracts own public validation and metadata. SDK owns orchestration and ports, with no vendor, SQL, network or filesystem implementation. Adapters own those implementations. API is the composition root. CLI only performs HTTP, local config and upload preparation. MCP is colocated with the API and uses the same authorization/dispatcher; it does not execute a second pipeline.

### Changing a source

Every source kind has a concrete class in [the source directory](../packages/adapters/src/sources/). [`DownloadSource`](../packages/adapters/src/sources/download.ts) implements the SDK's `SourceAdapter` interface. Its public `resolve` and `materialize` methods enforce the source kind and deadline. Materialization also creates the attempt workspace, checks the byte limit, and fingerprints the result. Each subclass supplies the source-specific lookup and download steps.

For a Telegram proxy change, start in [`TelegramSource`](../packages/adapters/src/sources/telegram.ts). For an Instagram URL change, start in [`InstagramSource`](../packages/adapters/src/sources/instagram.ts). Instagram, YouTube and X each own their site policy and inherit the yt-dlp command and credential handling from `YtDlpSourceBase`. Generic `yt_dlp` requests use a separate class and the registered site policies. To replace Instagram for an embedding application, supply `new NodeSources({ files, overrides: { instagram: myAdapter } })`.

### Changing a model provider

The SDK calls a `ProviderAdapter` to resolve a model, choose the chunk duration and input format, process one chunk, and translate its result when requested. [`NodeProviders`](../packages/adapters/src/providers.ts) selects the implementation by the request's provider ID. The concrete classes in [the provider directory](../packages/adapters/src/providers/) own their capabilities, model defaults and vendor behavior.

```mermaid
classDiagram
  class ProviderAdapter {
    <<interface>>
  }
  ProviderAdapter <|.. ApiProvider
  ProviderAdapter <|.. SubscriptionProvider
  ApiProvider <|-- OpenAiProvider
  ApiProvider <|-- GeminiProvider
  ApiProvider <|-- GoogleSpeechProvider
  SubscriptionProvider <|-- CodexProvider
  SubscriptionProvider <|-- ClaudeCodeProvider
```

For a Gemini upload or polling change, start in [the Gemini class](../packages/adapters/src/providers/gemini.ts). The API providers share deadline handling and a translation service selected at composition time. The subscription providers share frame and transcript preparation. Each supplies its own native CLI reasoning implementation and uses its subscription for translation. Codex also owns the realtime transcription path.

## Persistence and recovery

A job is acknowledged after its atomic insert. Optional idempotency keys are unique per owner and bound to a normalized request including the resolved model. PostgreSQL claims queued or expired-running rows with `FOR UPDATE SKIP LOCKED`, assigns a new lease token and increments the attempt. Every checkpoint/final write checks running state, token and expiry under a row lock. Heartbeats extend the lease; loss aborts work. Provider side effects remain at least once.

Each attempt re-materializes source bytes, audio only when the provider's `sourceMedia` says so. Their SHA-256 fingerprint must match saved checkpoints before reuse. The first attempt places chunk boundaries in measured pauses, overlapping neighbors only where none exists; see [ADR 0009](adr/0009-pause-aligned-chunks.md). Chunk plans and outputs are persisted independently; aggregation orders chunks, offsets timestamps, keeps overlapped items in one owning chunk and stitches overlapped transcripts. Only failed jobs are manually retried. Completion requires all planned outputs. SDK embedding can replace any individual port or use `MemoryJobRepository` for ephemeral processing.

Jobs store public fields plus owner, request hash, plan, chunk outputs and lease state. Indexed SQL columns support lookup/claims; a JSONB document holds the complete record. Successful completion writes a separate owner-scoped `processed_media` record in the same fenced transaction. It preserves the output, media ID, request and available source/inspection metadata independently of the execution row. Migration 003 backfills existing completed outputs.

Completed and failed job records expire after 30 days. An indexed, bounded janitor runs at startup and every minute; queued/running jobs stay available. A completed job can be removed only after its result is archived. Expired failed inputs remain standalone uploads. Retained outputs have no automatic expiry. See [ADR 0007](adr/0007-retained-results-and-job-expiry.md).

Unless `request.force` is true, the worker reuses the newest retained output for the same owner and an equivalent request: kind, provider, resolved model and languages, plus the exact prompt for understanding. It checks the resolved site media ID (scoped by source kind and download provider) before downloading, then the content fingerprint after materializing. A hit completes the job through a lease-fenced write with `cachedFrom` and no new history row. See [ADR 0008](adr/0008-result-reuse.md).

`auth_entries` stores expiring client/consent/code/token records; bearer/code keys are hashed and `take` is atomic. The server prunes expired auth entries hourly. Uploads live on the shared media volume under owner and deterministic content/name identifiers; stable identities make repeated local submissions idempotent.

The admin workspace at `/admin` has a public login shell and uses the same authenticated operation catalog for jobs, retained history, results and retry. The browser keeps the token in memory, renders stored content as text and omits credentials on source links. A content security policy restricts scripts and network requests to the service origin.

## Security and limits

Single owner. An owner token authenticates CLI/API. OAuth consent requires that owner token, a same-origin form and a one-use cookie binding; clients need S256 PKCE. Access tokens bind exact resource and scopes. DCR registration grants no access. CIMD fetch is bounded and DNS-pinned. Host checks run before routing; authentication precedes large protected-body buffering. Public OAuth routes enforce their own small body limit.

The `info` operation is authenticated but has no media-scope requirement, so a write-only client can check contract compatibility without gaining read access to jobs. All other operations enforce their catalog scopes.

Never accept a server path through the wire contract. Public HTTP sources block private-address resolution and redirects. ffmpeg disables network protocols and playlist demuxers. Extra yt-dlp hosts and the Telegram proxy are operator-trusted configuration. Upload API uses JSON base64 up to 32 MiB. Source materialization defaults to 1 GiB. The service releases uploaded inputs after successful processing under the [upload retention policy](adr/0006-upload-retention.md).

## Evolution

Add an operation once in contracts, implement its dispatcher case, and extend behavior tests. Structural schemas must express wire constraints; validation-only refinements must not silently disappear from generated JSON Schema. Keep library/API/CLI versions synchronized. A tagged release contains matching image, CLI, libraries and manifest. Migrations are explicit deployment steps. Neon provisioning is left to the owner; no Vercel deployment is part of this implementation.

Download sites are selected through a registry with exact hosts and permitted extractors; per-site cookie settings do not spill into other providers. Provider input format selection keeps vendor decisions outside SDK orchestration and preserves native Gemini video.

## Subscription providers

`codex` supports transcription through native app-server WebRTC v3 and understanding through prepared context. `claude-code` supports understanding only. For audio-bearing understanding inputs, the adapter first obtains a Codex transcript; it samples timestamped frames from video and supplies both in the initial Codex/Claude request. Silent video skips ASR, and audio-only understanding uses the transcript without frames. The understanding agent does not download media or perform its own transcription.

The source, media, repository and provider ports remain independent. Subscription preparation and process control belong in adapters, not SDK branches or transport handlers. `ProviderAdapter.inputFormat` chooses the chunk representation; `process` prepares input and validates model output. Translation stays in the selected subscription path. Failure never selects a paid API fallback.

Chunk/result provenance can identify Codex realtime transcription with `{ provider: 'codex', protocol: 'realtime-v3', model: null }` and preserve `frameIntervalMs`. The reasoning model and ASR backend are distinct. The top-level ASR route label `codex-realtime-v3` does not assert the backend's model identity. Checkpoints retain provenance; aggregation must not silently mix incompatible provenance.

Native CLIs run with pinned versions, dedicated persisted writable credential homes, an allowlisted environment and isolated per-job directories. Initial media context is bounded; output, timestamps and cleanup are checked. Credential-home locks serialize native refresh across processes; stale ownership requires operator inspection rather than automatic lock stealing. Host credential stores, unrelated hooks/MCP servers and API-key overrides do not flow into these subprocesses.

See [media providers](media-providers.md) for setup, route limitations and the distinction between deterministic tests, the successful short ASR probe, and unverified live deployment behavior. [Agent context](agent-context.md) is the short starting point for subsequent sessions.
