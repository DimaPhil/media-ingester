# ADR 0005 · Run a single-owner container with durable storage

**Status** Accepted

## Context

Media jobs can outlive an HTTP request. Workers run ffmpeg, download source media and sometimes launch native CLIs that refresh credentials on disk. Hosting just the request handlers on Vercel would still require a separate worker and persistent storage. The original [deployment decision](../reimplementation-plan.md#resolved-decisions) kept the long-running service and left Neon provisioning to the owner.

## Decision

Run the API and worker together in the [Compose service](../../docker-compose.yml). Store jobs and OAuth records in PostgreSQL and use persistent volumes for media and CLI credential homes. Apply database migrations explicitly. Use one configured HTTPS origin for clients and OAuth. The owner bearer grants direct access and authorizes OAuth consent. Client registration alone grants no access. Source-service credentials, including the Telegram proxy bearer, belong to their own integration.

## Consequences

An operator must supply ingress, PostgreSQL and backups for both database records and uploaded bytes. Changing the origin affects OAuth discovery and resource binding. Exposing the owner bearer grants access to the owner's media operations. Before modifying deployment or authentication, consult the [runbook](../ubuntu-deployment.md), [OAuth implementation](../../apps/api/src/auth/index.ts), and [authorization tests](../../apps/api/test/auth.test.ts).
