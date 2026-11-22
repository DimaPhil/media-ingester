# ADR 0014 · Tell agents what failed, where a job is, and what to call next

**Status** Accepted. Extends the job contract of [ADR 0001](0001-operation-catalog.md) additively; adds stage writes to the fenced lifecycle of [ADR 0003](0003-worker-recovery.md) within the idle budget of [ADR 0013](0013-idle-database-quiet.md); bounds Gemini re-requests from [ADR 0011](0011-gemini-youtube-urls.md).

## Context

A three-hour Russian YouTube transcription with Gemini 2.5 Flash failed nondeterministically. The job reported `processing_failed` with "check server logs", and the log line held only the error class, `SyntaxError`. A reproduction captured the cause: `finishReason: STOP`, about 5,000 output tokens, and JSON whose string values contained unescaped quotes from direct speech. The request set only `responseMimeType`, so nothing constrained the output to valid JSON. Parse failures were not re-requested, and finish reasons, prompt block reasons and HTTP statuses were discarded. An agent polling the job could not tell a transient model failure from a bad source, which chunk failed, whether retrying would reuse work, or how long to wait between polls.

## Decision

**Constrained Gemini output.** Every Gemini call sends `generationConfig.responseJsonSchema` (JSON Schema) next to `responseMimeType: application/json`: chunk transcription, chunk understanding, synthesis and translation. Constrained decoding escapes quotes inside strings. Timestamps stay strings in the `MM:SS` format of ADR 0011. Unusable output (invalid JSON, missing fields or empty text) is requested again within the existing three-call budget per chunk, synthesis or translation, shared with drifting timestamps. The response is then classified: a prompt `blockReason` or a refusal finish reason (`SAFETY`, `RECITATION`, `LANGUAGE`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, image refusals) is `provider_blocked`, and `MAX_TOKENS` is `provider_output_truncated`. Neither is requested again or marked retryable.

**Specific provider codes.** All API providers share the classification in `providers/shared.ts`:

| Code                        | Meaning                                                                                                       | Retryable     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------- |
| `provider_http_error`       | Non-success status, `details.httpStatus` set. The body is discarded.                                          | 408, 429, 5xx |
| `provider_unavailable`      | Network failure before any response                                                                           | yes           |
| `provider_timeout`          | The provider deadline passed. Worker cancellation (shutdown, lost lease) is not reported as a timeout.        | yes           |
| `provider_invalid_output`   | Unparseable, empty or schema-invalid output after the call budget, with `parseErrorPosition` or `schemaPath`. | yes           |
| `provider_output_truncated` | Output token limit reached                                                                                    | no            |
| `provider_blocked`          | Prompt or answer refused                                                                                      | no            |
| `provider_not_configured`   | Missing credential                                                                                            | no            |
| `provider_rejected`         | Gemini could not process the uploaded file                                                                    | no            |
| `media_too_large`           | Chunk exceeds the provider's request limit                                                                    | no            |

Subscription providers keep their `subscription_*` codes. The SDK's `invalid_provider_output` remains for output that parsed but failed semantic validation (timestamps outside the chunk, empty synthesis); it is now retryable because model output varies between calls. Unknown errors stay `processing_failed`.

**Error details.** `JobError` gains optional `details`: a flat record of strings (at most 200 characters), finite numbers, booleans and nulls. The worker adds generic context: `stage`, `attempt`, and for provider stages `provider`, `model`, `chunkIndex`, `chunkStartMs` and `chunkEndMs`. Adapters add vendor context such as `finishReason`, token counts, `httpStatus`, `parseErrorPosition` and `calls`; their `provider` and `model` describe the call that actually failed, for example a Gemini translator serving an OpenAI job. Unknown errors record only `errorName`. The SDK drops nested values and any string that looks like a URL. Provider bodies and model output never enter messages or details.

**Stage.** Job views carry `stage`: `queued`, `resolving`, `downloading`, `inspecting`, `planning`, `processing`, `synthesizing`, `translating`, `completed` or `failed`. Claiming sets `resolving` and saving a plan sets `processing` in writes that already happen. The worker adds a fenced `saveStage` write only before slow steps: download, inspection, loudness analysis (only when it runs), synthesis and translation. That makes at most five extra writes per attempt, none per chunk, and only while a job runs, so idle behavior under ADR 0013 is unchanged. Terminal and queued stages follow the status. Records written before 1.6.0 derive `resolving` or `processing` from their chunk counts. `planning` covers loudness analysis. The planned `finalizing` stage was dropped because the final write follows aggregation immediately and would never be observed.

**Next steps.** A next step is structured data: `{ operation, input, reason, pollAfterSeconds? }`, where `operation` is a catalog operation name and `input` is that operation's complete input. REST and MCP return it as is; the CLI renders it as a `media` command. Steps are computed when a view is built, never stored. Active jobs carry top-level `nextSteps` with one `get` step and a poll interval: 5 s queued, 10–15 s for preparation stages, 30 s while processing chunks. Failed jobs carry `error.nextSteps`:

- `retry` when the error is retryable, stating how many completed chunks it reuses;
- `submit` with an alternative provider when the failure is provider-specific. Candidates come from the optional `ProviderAdapter.alternatives`, which `NodeProviders` limits to configured paid API providers that support the request kind. Subscription requests get none, consistent with ADR 0004.
- `submit` of the same request after `source_changed`, or `resolve` of the source after a non-retryable source or media error.

Completed jobs carry no steps.

**Logs.** `onProcessingError` receives the recorded failure as a third argument. The server writes one JSON line per failed attempt: `event: job_failed`, `jobId`, `code`, `retryable`, `errorName`, the service-written message of a `MediaError`, and the sanitized details.

**CLI.** The CLI keeps JSON output. A failure prints `{ "error": { code, message, details? }, "help": [...] }` to stdout and exits 1. Usage and local input errors use exit code 2 and list valid options. A single job view with steps gains a top-level `help` array of rendered commands. Progress, such as an upload notice, goes to stderr. Each command's help shows at most three examples. The client keeps a server error code only when it matches `^[a-z][a-z0-9_]{0,63}$`; it never reflects server messages.

## Consequences

Agents can branch on `code` and `retryable`, follow `nextSteps` without parsing prose, and poll at a suggested pace. Operators can find the failing chunk, finish reason and token usage in one log line. All job fields are optional additions, so tolerant clients such as tldr-feed keep working. The contract fingerprint changes, so a 1.5 CLI refuses mutations against a 1.6 server, as with any release. A Gemini schema rejection would surface as `provider_http_error` 400 on every call. The schema format follows the documented `responseJsonSchema` field, but its live behavior with video input on Gemini 2.5 has not yet been checked. A constrained answer can still be truncated or refused; those now fail fast with specific codes instead of being retried. Alternative-provider suggestions use another vendor's quota. They are suggestions only, and an agent should follow them only within the user's authorization. A failed job retains the details of its last attempt only.

[Contracts](../../packages/contracts/src/media.ts) · [Job views and failures](../../packages/sdk/src/job-view.ts) · [Worker](../../packages/sdk/src/worker.ts) · [Provider errors](../../packages/adapters/src/providers/shared.ts) · [Gemini](../../packages/adapters/src/providers/gemini.ts) · [Failure log](../../apps/api/src/logging.ts) · [CLI output](../../packages/cli/src/output.ts) · [SDK tests](../../packages/sdk/test/job-view.test.ts) · [Provider tests](../../packages/adapters/test/providers.test.ts) · [CLI tests](../../packages/cli/test/cli.test.ts)
