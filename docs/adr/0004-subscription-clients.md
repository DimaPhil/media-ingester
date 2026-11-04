# ADR 0004 · Run subscriptions through isolated native clients

**Status** Accepted

## Context

A subscription selection determines which account pays for processing, how its credentials refresh, and what input the model can actually see. Passing a host agent's settings into a worker can introduce tools, hooks, or credentials that the service did not authorize.

## Decision

Use pinned native CLIs with separate persistent credential homes, bounded process lifetimes and an allowlisted environment. Stage timestamped frames and any Codex realtime transcript before invoking the chosen understanding client. Skip ASR for silent media. Claude Code handles understanding, with Codex providing ASR when needed. Keep translation on the selected subscription route. A subscription failure fails the operation rather than spending paid API credits. [Preparation](../../packages/adapters/src/subscription-understanding.ts) · [Subprocess isolation](../../packages/adapters/src/subscription-runtime.ts) · [Provider classes](../../packages/adapters/src/providers/)

## Consequences

Operators perform native login and maintain the credential volumes. Frame sampling can miss events between samples. Preserve the distinction between deterministic behavior tests and live evidence for a particular account, CLI version and media sample. [Routing tests](../../packages/adapters/test/subscription-routing.test.ts) · [Provider setup and evidence](../media-providers.md)
