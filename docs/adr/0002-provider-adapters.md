# ADR 0002 · Give each provider a concrete adapter

**Status** Accepted

## Context

The worker needs to orchestrate a job regardless of where the bytes came from or which model handles them. Putting platform-specific behavior in the worker or a central switch makes a change to one platform touch unrelated providers. Duplicating download and process controls in every class would make those controls harder to audit.

## Decision

The SDK owns the source, media, model and repository interfaces. Each built-in source kind and model provider has a concrete class in its own file. Shared bases own common lifecycles. For example, Instagram owns its URL and extractor policy, inherits the yt-dlp download process, and ultimately inherits the bounded attempt workspace and fingerprinting from `DownloadSource`. The API assembles the defaults. Embedders may override one registry entry. [SDK ports](../../packages/sdk/src/ports.ts) · [Instagram](../../packages/adapters/src/sources/instagram.ts) · [Source registry wiring](../../packages/adapters/src/sources.ts) · [Model registry wiring](../../packages/adapters/src/providers.ts)

## Consequences

Change a site's protocol or a model's input policy in its adapter. A new public provider ID also needs contract support and a registry entry. Changes to a base class must work for every subclass that inherits it. [Source tests](../../packages/adapters/test/sources.test.ts) · [Model contract tests](../../packages/adapters/test/provider-contract.test.ts) · [Embedding examples](../../packages/sdk/README.md)
