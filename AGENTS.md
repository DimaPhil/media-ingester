# Working on Media Ingest

Read README.md for commands, docs/architecture.md for invariants, and docs/agent-context.md for provider decisions and unfinished live validation. The visual design is .artifact-review/architecture.html; keep it consistent when changing boundaries or data models.

- Use pnpm 10.6.1, TypeScript ESM/NodeNext, oxlint and oxfmt. Keep Markdown paragraphs on one physical line.
- Contracts are the single catalog for REST, CLI and MCP. Express constraints structurally so JSON Schema matches runtime validation. Add new behavior in the API dispatcher and parity tests.
- SDK owns lifecycle and interfaces. Never import SQL, HTTP, filesystem, child processes or vendor SDKs there. Put concrete implementations in adapters.
- CLI/client must never import SDK, adapters or API internals. CLI media actions call HTTP. Local-file processing requires upload first.
- Every persistence mutation must preserve owner isolation, atomic idempotency and lease fencing. Save each chunk before aggregation; compare source fingerprints before reusing checkpoints. Provider calls are at least once.
- Authentication is mandatory. OAuth registration is not consent. Preserve PKCE, exact redirect/resource binding, scopes, single-use codes and SSRF-safe client metadata retrieval.
- Never log tokens, credentials, provider bodies or private source URLs. Do not read .env files to inspect secrets.
- Subscription providers use native CLIs and dedicated persisted credential homes. Codex realtime v3 owns subscription transcription; Claude Code does not perform native ASR. Prepare frames and any Codex transcript before starting the understanding agent, and include them in its initial context. Silent video skips ASR. Never fall back to paid APIs, including translation.
- Keep subscription subprocesses isolated from inherited API keys, host agent settings, MCP servers, hooks and unrelated files. Preserve pinned CLI versions and bounded process/session cleanup; validate upgrades with both deterministic tests and separately reported live smoke evidence.
- PostgreSQL migrations are explicit. Do not mutate a live database for tests. TEST_DATABASE_URL must point to disposable test storage; persistence and E2E suites reset tables and run sequentially.
- Required gate: pnpm check with PostgreSQL and ffmpeg available. It includes lint, format, typecheck, boundaries, coverage, E2E and offline CLI package installation. Build the Docker image for deployment changes.
- Keep all package/API versions and RELEASE_VERSION aligned. Tagged releases publish matching server and CLI assets; do not claim a local build is deployed.
- Uploads and job results are retained until explicit operator cleanup. Do not add destructive retention policies silently.
- Prefer one writer per area; independent read-only reviews may run concurrently.
