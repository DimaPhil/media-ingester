import { describe, expect, it } from 'vitest';
import { providerSchema, requestSchema } from '@media-ingest/contracts';
import { BUILTIN_PROVIDER_CAPABILITIES } from '../src/providers.js';

describe('built-in provider capabilities', () => {
  it('covers every provider accepted by the contract', () => {
    expect(Object.keys(BUILTIN_PROVIDER_CAPABILITIES).sort()).toEqual(
      [...providerSchema.options].sort(),
    );
  });

  it.each(providerSchema.options)('agrees with the wire contract for %s', (provider) => {
    const capabilities = BUILTIN_PROVIDER_CAPABILITIES[provider];
    for (const kind of ['transcription', 'understanding'] as const) {
      const request = {
        kind,
        provider,
        prompt: 'Describe the clip',
        source: { kind: 'upload', uri: 'clip' },
      };
      expect(requestSchema.safeParse(request).success).toBe(capabilities[kind]);
    }
  });
});
