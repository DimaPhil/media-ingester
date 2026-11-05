# Architecture decisions

| Decision                                                                                       | Read when changing                                     |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [0001 · Share one operation catalog](0001-operation-catalog.md)                                | REST, MCP, CLI, operation scopes or wire schemas       |
| [0002 · Give each provider a concrete adapter](0002-provider-adapters.md)                      | Sources, model providers, SDK ports or server wiring   |
| [0003 · Fence durable work and checkpoint each chunk](0003-worker-recovery.md)                 | Persistence, retries, concurrency or idempotency       |
| [0004 · Run subscriptions through isolated native clients](0004-subscription-clients.md)       | Codex, Claude Code, authentication, ASR or translation |
| [0005 · Run a single-owner container with durable storage](0005-deployment-and-identity.md)    | Ubuntu, Neon, ingress, owner access or OAuth identity  |
| [0006 · Release uploaded inputs after successful processing](0006-upload-retention.md)         | Upload ownership, shared inputs, retry or cleanup      |
| [0007 · Keep outputs and expire terminal job records](0007-retained-results-and-job-expiry.md) | Processing history, job expiry and the admin workspace |

These records explain accepted choices. For a change that alters a boundary or recovery guarantee, add a numbered record with status, context, decision, consequences, and links to the implementing code and tests. If a new decision replaces one here, mark the earlier record superseded and link both ways. Keep operational procedures in the [README](../../README.md) and implementation navigation in the [agent guide](../agent-context.md).
