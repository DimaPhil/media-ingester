# ADR 0012 · Lock Codex ASR only while a session starts

**Status** Accepted. Refines the credential locking of [ADR 0004](0004-subscription-clients.md).

## Context

Codex realtime ASR streams audio at playback speed. The credential lock wrapped each whole session, so chunks ran one at a time regardless of `MEDIA_CHUNK_CONCURRENCY`; an hour of audio took over an hour. Live runs after [ADR 0009](0009-pause-aligned-chunks.md) also showed two failures. A pause cut could isolate a few seconds of room tone, which Codex answers with no transcript, and the job failed with an empty-transcript error. Separately, each session left two UDP sockets open in the API process.

## Decision

The lock exists to serialize native credential refresh, which happens while a client starts. Codex ASR now holds it through the version check, app-server start and realtime handshake, and releases it when the WebRTC session connects. Release is idempotent, so the final cleanup never removes a lock another chunk has acquired since. Reasoning calls for understanding, synthesis and translation keep the lock for their whole run.

Codex opens a `turn.created` event when its voice detection hears speech. A session that ends with no transcript and no turn returns an empty transcript. Missing words after a turn remain an error, as before. All-zero audio still skips ASR entirely.

The adapter records every ICE connection gathered for the offer and closes each one after the peer, because bundling removes one transport from the peer's list while its sockets stay open. Peer shutdown is bounded and never throws, so a stalled close cannot discard a finished transcript; if the peer does not close within two seconds, its transports are stopped directly. The app-server and the audio encoder each lead their own process group. Cleanup sends SIGTERM to the group, then SIGKILL after one second or as soon as the leader exits, and stops waiting after three seconds; `codex` is a Node launcher for a native binary, which signalling only the launcher could orphan.

## Consequences

Live on 2026-11-10, three concurrent sessions on one ChatGPT account completed in 71 seconds instead of about 200, and no UDP sockets remained afterwards. After twelve more sessions the API process held only its listener and database sockets, with no child processes left. A refresh that a running session performs mid-stream is not serialized; sessions last at most about 70 seconds, so this is unlikely but not excluded. Codex understanding still waits for its reasoning lock, so its gain is smaller than transcription's; Claude Code reasoning uses its own credential home and overlaps fully with Codex ASR. Account-level limits on concurrent realtime sessions are not documented; keep chunk concurrency modest. Speech that Codex's voice detection misses entirely is reported as no speech.

[Codex audio](../../packages/adapters/src/codex-audio.ts) · [Realtime session](../../packages/adapters/src/codex-realtime.ts) · [Credential lock](../../packages/adapters/src/subscription-runtime.ts) · [Tests](../../packages/adapters/test/codex-audio.test.ts) · [Lock tests](../../packages/adapters/test/subscription-runtime.test.ts)
