# ADR 0010 · Synthesize one answer for multi-chunk understanding

**Status** Accepted. Builds on [ADR 0009](0009-pause-aligned-chunks.md).

## Context

Each understanding chunk is answered from its own span: at most 60 seconds for subscription providers and 10 minutes for Gemini. Aggregation joined those answers, so a one-hour video produced sixty independent minute summaries and no answer to the user's task for the whole media.

## Decision

After all chunks are checkpointed and aggregated, an understanding job with more than one chunk makes one more call, `ProviderAdapter.synthesize`. Its input is every chunk answer placed on the absolute timeline with its time ranges. The provider returns the final text and absolute time ranges, which replace the concatenated text and chunk ranges. Translation then applies to the synthesized text.

Inputs above 200,000 characters are combined span by span first. Each intermediate call keeps every task-relevant detail for its span, and each level at least halves the number of parts. Output must be non-empty and its time ranges must lie within the span; otherwise the job fails with `invalid_provider_output`.

Gemini synthesizes with a text-only call to its understanding model. Codex and Claude Code use the selected agent with no media attached. A provider that returns `null`, including a registry override without `synthesize`, keeps the concatenated answers. Transcription and single-chunk understanding are unchanged.

## Consequences

Each multi-chunk understanding job uses one or more extra model calls; subscription synthesis consumes quota and holds the agent's credential lock like any reasoning call. The synthesis is not checkpointed. A crash before completion repeats it, consistent with at-least-once provider calls. Per-chunk answers stay in the job record until the record expires; the retained result holds only the synthesized answer. Synthesis sees chunk answers, not raw transcripts or frames, so details a chunk answer omitted cannot be recovered.

[Synthesis](../../packages/sdk/src/synthesis.ts) · [Worker](../../packages/sdk/src/worker.ts) · [Prompt](../../packages/adapters/src/providers/shared.ts) · [SDK tests](../../packages/sdk/test/synthesis.test.ts) · [Adapter tests](../../packages/adapters/test/providers.test.ts)
