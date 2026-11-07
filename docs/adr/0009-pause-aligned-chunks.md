# ADR 0009 · Cut chunks in pauses and download only the streams a provider reads

**Status** Accepted. Refines chunk planning under [ADR 0003](0003-worker-recovery.md).

## Context

Long media is split into provider-sized chunks: 60 seconds for subscription providers, 55 seconds for Google Speech, 10 minutes for other API providers. Boundaries were a fixed grid, so a cut usually fell inside a word. Both neighbors received a fragment, and the word was garbled or lost. Codex realtime ASR made this worse by appending silence directly after the fragment. Separately, yt-dlp sources always downloaded the muxed video format, even when the provider only read audio.

## Decision

Before planning a job's first attempt, the worker asks the media adapter for a loudness profile: dBFS per 20 ms frame of the first audio stream, decoded in one streaming pass. This happens only when the media has audio and needs more than one chunk. `planChunks` searches the last quarter of each chunk for the quietest 300 ms window. A window counts as a pause when it is below −45 dBFS or 12 dB below the span's median. The cut is placed at the center of the surrounding run of near-minimal windows. Chunks never exceed the provider limit.

When the search finds no pause, as with continuous music or speech over a music bed, the neighbors overlap by up to 2 seconds on each side of the limit. `keepStartMs`/`keepEndMs` record the range each chunk owns. Aggregation keeps a segment or time range only in the chunk whose keep range contains its midpoint. Transcription text is stitched at the longest run of at least three words shared by the overlapping texts; this also drops the partial words at each extraction edge. Without such a run, both texts are kept, so a few words may repeat but none are lost. Understanding prose is not stitched.

The plan is saved before any chunk runs and stays authoritative on retries, so analysis never reshapes checkpoints. Plans without keep fields, including all plans saved before this change, behave as before.

Providers declare `sourceMedia(request)`. API transcription providers and Codex transcription read audio; Gemini keeps native video for both kinds, and understanding reads video. The worker passes `{ audioOnly: true }` to `materialize`. yt-dlp then selects `bestaudio/best[ext=mp4]/best`; other sources ignore the hint. Overrides without `sourceMedia` keep the full source.

## Consequences

Measured on a public 14-minute talk with 60-second chunks, analysis took 1.7 seconds and all 15 boundaries fell in pauses between −45 and −61 dBFS, at the cost of one extra chunk. A music video fell back to overlaps at every boundary. Audio-only download of the same talk was 13 MB instead of 82 MB.

Text stitching depends on whitespace-separated words. For languages written without spaces, an overlap keeps both texts whole. Timed segments longer than the overlap can still both survive the midpoint rule. Audio-only artifacts have a different content fingerprint than the muxed file, so fingerprint reuse does not match across the two; site media ID reuse is unaffected. The retained inspection of such a job reports no video stream.

[Planner and stitching](../../packages/sdk/src/chunks.ts) · [Worker](../../packages/sdk/src/worker.ts) · [Loudness](../../packages/adapters/src/media.ts) · [yt-dlp selection](../../packages/adapters/src/sources/yt-dlp-base.ts) · [Planner tests](../../packages/sdk/test/chunks.test.ts) · [Media tests](../../packages/adapters/test/files-media.test.ts)
