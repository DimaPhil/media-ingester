# ADR 0001 · Share one operation catalog

**Status** Accepted

## Context

People use the CLI, REST clients and MCP agents to operate on the same jobs. A separately maintained operation list or schema for each client could advertise inputs the server rejects, or omit a scope enforced elsewhere.

## Decision

Define each operation's ID, method, path, scope, input and output in the contracts package. REST and MCP handle their own protocol details and route through the same dispatcher. The CLI uses the HTTP client, uploading local media before submitting a remote job. Embedded programs call the SDK directly. [Catalog](../../packages/contracts/src/operations.ts) · [REST](../../apps/api/src/rest.ts) · [MCP](../../apps/api/src/mcp.ts) · [Dispatcher](../../apps/api/src/operations.ts)

## Consequences

Adding an operation requires a structural wire schema and a dispatcher case. Test the operation through the exposed transports. Keep client packages independent of the processing runtime so installing the CLI does not pull in workers or vendor clients. [Boundary checks](../../scripts/check-boundaries.ts) · [Service E2E tests](../../test/e2e/service.test.ts)
