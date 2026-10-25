# Media reimplementation plan

## Deliverables and acceptance

A pnpm monorepo with a deployable API, HTTP-only `media` CLI, embeddable SDK, interchangeable persistence and media adapters, current MCP transport with OAuth client metadata and DCR compatibility, synchronized release artifacts, concise agent instructions, and an HTML architecture reference. Required evidence: typecheck, oxlint, oxfmt, existing Vitest gates adapted to the new architecture, persistence concurrency/recovery tests, API/CLI/MCP contract tests, package installation smoke tests, and container build where available. External provider calls and deployment require separate configured environments; local validation must not pretend to prove them.

## Boundaries

- `@media-ingest/contracts`: versioned request/result schemas and operation catalog. Generates OpenAPI, CLI commands and MCP tools. No execution or persistence.
- `@media-ingest/sdk`: operation lifecycle, chunk planning, checkpoint recovery, aggregation and port interfaces. No HTTP server, SQL, vendor SDK or process execution. Includes an in-memory repository for embedding and tests.
- `@media-ingest/adapters`: Node media/source/provider implementations and PostgreSQL persistence. Consumers can reuse these or implement individual SDK ports.
- `@media-ingest/client`: typed, validated HTTP client used by CLI and other remote callers. No SDK dependency. The colocated MCP server uses the same application dispatcher as REST.
- `@media-ingest/cli`: `media` commands, configuration, upload, shell completion and bundled skill installation. Every media action calls the deployed API.
- `apps/api`: composition root, authentication, request limits, REST routes, durable worker and HTTP MCP. MCP and REST dispatch the same catalog operations with the same authorization and schemas.

## Execution design

Submission validates and atomically persists a queued job before acknowledging. Workers claim jobs using expiring leases and fencing tokens; checkpoints and final writes require the active lease. Completed chunk outputs survive process restarts. Retries reuse successful chunks. Provider calls are at least once after interruption; exactly-once external billing is not promised. Final aggregation sorts chunks and offsets timestamps. Database and media files are separate ports. Upload identifiers are opaque; clients never submit server filesystem paths.

## Contract and release enforcement

One catalog owns operation IDs, methods, paths, schemas, scope and descriptions. REST registration, CLI commands and MCP tool descriptors iterate it. Tests check coverage, invalid inputs, matching outputs and authorization. Dependency checks prohibit clients importing execution code. All published packages and API use one release version; CI builds and tests tarballs and container from the same revision. A contract fingerprint detects incompatible deployed servers before mutations.

## Implementation sequence

1. Inventory current capabilities and resolve compatibility/authentication scope.
2. Establish contracts and SDK ports; record decisions before implementation.
3. Implement SDK lifecycle and adapters with isolated tests.
4. Compose API/auth/MCP and HTTP-only client/CLI.
5. Add release, completion, skill-installation and boundary enforcement.
6. Run required checks; fix failures; produce and visually review high-level and technical HTML reference.

## Resolved decisions

The user confirmed a complete rewrite: old code and database are reference only, with no compatibility requirement. The service remains private and single-owner, with authenticated CLI/API and owner-approved MCP OAuth. A Vercel deployment was considered and withdrawn because media work requires separate compute; retain the long-running server/container design. The user will provision and attach Neon. Add end-to-end tests through real HTTP, CLI, MCP and PostgreSQL. No remote provisioning or deployment is needed.

## Authorized subscription extension

Add `codex` transcription through the native app-server WebRTC v3 path and `codex` / `claude-code` understanding through timestamped frames plus a Codex transcript prepared before the agent starts. Silent video skips ASR. Keep transcript provenance distinct from the understanding model; the realtime ASR backend model identity is unknown. Translation stays on the selected subscription agent, with no paid fallback. Use isolated persistent credential homes, pinned CLI versions, native login, bounded sessions, cancellation and output validation. Extend deterministic tests and document live smoke evidence separately. Update the HTML reference and concise repository context without reopening the user-waived artifact review loop.
