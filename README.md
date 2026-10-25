# Media Ingest

Private media transcription and understanding service. The `media` CLI calls the API; the SDK runs the same processing logic inside another Node application with replaceable storage, source, media and provider adapters.

## Layout

| Module               | Responsibility                                                               |
| -------------------- | ---------------------------------------------------------------------------- |
| `packages/contracts` | Zod models, operation catalog and OpenAPI                                    |
| `packages/sdk`       | Job lifecycle, leases, chunk checkpoints, aggregation; in-memory persistence |
| `packages/adapters`  | PostgreSQL, filesystem uploads, ffmpeg, sources and model providers          |
| `packages/client`    | Validated HTTP client; no execution logic                                    |
| `packages/cli`       | Bundled `media` executable, completion and agent skill                       |
| `apps/api`           | REST/MCP, private-owner OAuth, worker composition                            |

See [architecture](docs/architecture.md), [provider setup](docs/media-providers.md), [SDK embedding](packages/sdk/README.md), [CLI setup](packages/cli/README.md), and the [HTML design](.artifact-review/architecture.html). Future sessions should start with [agent context](docs/agent-context.md). This is a fresh schema and API; old database records are not migrated.

## Run

Requires Node 22+, pnpm 10.6.1, PostgreSQL (Neon works), ffmpeg/ffprobe and yt-dlp. Docker includes the media tools.

```sh
pnpm install
cp .env.example .env
# Fill DATABASE_URL, MEDIA_OWNER_TOKEN and the provider credentials you use.
pnpm build
node --env-file=.env apps/api/dist/migrate.js
node --env-file=.env apps/api/dist/main.js
```

Generate the owner token with `openssl rand -hex 32`. Use `MEDIA_PUBLIC_URL=https://your-media-host` in production; place a TLS reverse proxy in front and preserve its Host header. The default loopback URL is for local development. Every operation and schema route requires authentication; `/healthz` and OAuth discovery/registration/consent are public protocol endpoints. Registration alone never grants media access.

For containers:

```sh
docker compose build
docker compose run --rm api node dist/migrate.js
docker compose up -d
```

Attach your Neon URL in `.env`; migrations explicitly create only `media_v1`. Startup checks the schema but never migrates it. The API binds to loopback on the host through Compose. Back up both PostgreSQL and the `media-data` volume: uploads are durable files, while jobs/results/checkpoints live in PostgreSQL. Uploads and completed results remain until operator cleanup; temporary attempt directories are removed after processing. Multiple API processes need the same media volume and synchronized clocks.

Configure only the providers you use. API-backed options use `OPENAI_API_KEY`, `GEMINI_API_KEY`, or Google service account/ADC with `GOOGLE_SPEECH_RECOGNIZER`. Models can be overridden with `MEDIA_OPENAI_MODEL`, `MEDIA_GEMINI_TRANSCRIPTION_MODEL`, `MEDIA_GEMINI_UNDERSTANDING_MODEL`, `MEDIA_GOOGLE_SPEECH_MODEL`, and `MEDIA_TRANSLATION_MODEL`. Google Speech uses the v2 API and short synchronous chunks. Gemini supports both operations; OpenAI and Google Speech support transcription.

Subscription options use native CLI login in dedicated persisted credential homes: `MEDIA_CODEX_HOME` and, for Claude, `MEDIA_CLAUDE_HOME`. `codex` supports experimental subscription transcription through app-server WebRTC v3 and understanding; `claude-code` supports understanding only. Both understanding paths receive prepared timestamped frames and a Codex transcript in the initial agent context. Silent video skips ASR. Translation stays on the selected subscription agent, and subscription failures never fall back to paid APIs.

The container pins Codex 0.163.0 and Claude Code 2.1.309. Compose persists their separate auth volumes at `/auth/codex` and `/auth/claude`. Log in through the native CLIs as the owner:

```sh
docker compose run --rm --no-deps -e CODEX_HOME=/auth/codex api codex -c 'cli_auth_credentials_store="file"' login --device-auth
docker compose run --rm --no-deps -e CLAUDE_CONFIG_DIR=/auth/claude api claude auth login --claudeai
```

Do not mount the host's normal agent home or copy live refresh-token stores. `MEDIA_CODEX_MODEL` and `MEDIA_CLAUDE_MODEL` select understanding models; defaults are `gpt-6.1-sol` and `sonnet`. `MEDIA_SUBSCRIPTION_TIMEOUT_MS` defaults to ten minutes per chunk/translation operation, including credential-lock waits; it is not a whole-job limit. See [provider setup and limits](docs/media-providers.md) for credential isolation, lock recovery, provenance and outstanding live acceptance.

HTTP, YouTube, Instagram single posts/reels, X status videos, Google Drive, Telegram proxy, and uploaded media have adapters. SDK consumers may also supply local files. The source registry restricts both hosts and extractor names. Generic `yt_dlp` selects a registered site; custom `YT_DLP_SITES_JSON` entries must specify hosts and extractors. A host allowlist alone no longer enables arbitrary extractors. Site availability still depends on account access and upstream behavior; Threads is not enabled.

Use `YT_DLP_AUTH_JSON` for per-site cookie/profile paths (see `.env.example`). Legacy `YT_DLP_COOKIES_PATH` and `YT_DLP_COOKIES_FROM_BROWSER` apply only to YouTube. Browser profiles can be mounted read-only into the downloader; cookie jars need a writable private copy if yt-dlp saves updated cookies. Static exports do not renew browser sessions. Third-party extractors require deployment egress controls; public HTTP downloads pin validated DNS and reject private networks. Telegram proxy URLs are trusted operator configuration.

Gemini preserves video for native video transcription and understanding. Subscription understanding uses sampled frames rather than native full-motion video input; it may miss events between samples. The [provider/server integration design](docs/media-providers.md) separates the earlier successful Codex ASR probe from current implementation checks and still-required deployment validation. Threads remains disabled.

## CLI and MCP

```sh
# Development CLI:
pnpm cli --help
# Released CLI (self-contained, no unpublished workspace dependencies):
npm install -g ./media-ingest-cli-1.0.0.tgz
export MEDIA_API_URL=http://localhost:4000
# Set MEDIA_API_TOKEN securely, or use media setup --token-stdin.
media transcribe ./recording.mp3 --idempotency-key recording-001
media transcribe ./recording.mp3 --provider codex
media understand ./recording.mp4 --provider claude-code --prompt 'Summarize the demonstration'
media get <job-id>
media completion zsh
```

Package installation installs the bundled skill into `~/.agents/skills/media-cli` with a Claude symlink. If lifecycle scripts are disabled, run `media skill install`. Existing unmanaged or edited skills are protected. Shell activation instructions are in the CLI README.

Connect MCP clients to `https://your-media-host/mcp`. The official SDK implements protocol `2026-07-28` and its legacy compatibility transport. OAuth advertises client metadata documents and DCR fallback; authorize through the server's owner-consent page. Tokens are short-lived, resource-bound and scope-checked. See [authentication details](apps/api/src/auth/README.md) for supported grants and limits.

Uploads/downloads through JSON are capped at 32 MiB; URL processing defaults to a 1 GiB download cap. Source/provider timeouts and chunk concurrency are bounded. Subscription chunks are at most 60 seconds, with frames sampled every 5 seconds; Codex ASR streams at playback speed. Submission is asynchronous: save the returned job ID and poll `get`. Failed jobs can be retried; successful chunk checkpoints are reused only when the source fingerprint is unchanged. An interrupted provider call can consume usage again on recovery—execution is at least once.

## Verification

```sh
docker compose -f compose.test.yml up -d --wait
export TEST_DATABASE_URL=postgres://postgres:test-only@127.0.0.1:54329/media_ingest_test
pnpm check
docker compose -f compose.test.yml down
```

`pnpm check` builds, typechecks, runs oxlint/oxfmt, verifies dependency and release boundaries, runs Vitest with 80% lines/statements/functions and 75% branch gates, runs real HTTP/CLI/MCP/PostgreSQL E2E, and installs the CLI tarball offline in an isolated home. The E2E database must be disposable and named with `test`; suites reset its `media_v1` tables. Run persistence tests and E2E sequentially when sharing a database. Tests use deterministic provider doubles; they do not spend external provider credits. An adapter test invokes real ffmpeg.

## Releases

All packages and the API use one version. Update the root/package versions and `RELEASE_VERSION` together; `check:boundaries` rejects drift. Tag `v<version>` to run the release workflow. It runs all gates, builds the API image, packs the self-contained CLI and libraries, and publishes one GitHub release only after all assets are uploaded to a draft. No npm registry is required for CLI installation. SDK consumers can install the matching contracts, SDK and adapters tarballs together, or publish the library set to their registry.

`pnpm release:prepare` creates local tarballs, OpenAPI and a revision/contract/hash manifest under `release/<version>`. CI adds the matching container image and checksums. The CLI checks the deployed contract before each mutation; the server also rejects mismatched supplied fingerprints. Source boundary checks forbid CLI/client imports of SDK or adapters. REST routes, MCP tools and CLI commands derive from the same catalog.
