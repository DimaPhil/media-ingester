import { describe, expect, it } from 'vitest';

import { createFingerprint } from '../src/fingerprint';

describe('createFingerprint', () => {
  it('is stable regardless of object key order', () => {
    const first = createFingerprint({
      b: 2,
      a: {
        z: 3,
        y: 1,
      },
    });
    const second = createFingerprint({
      a: {
        y: 1,
        z: 3,
      },
      b: 2,
    });

    expect(first).toBe(second);
  });

  it('changes when payload changes', () => {
    expect(createFingerprint({ value: 1 })).not.toBe(createFingerprint({ value: 2 }));
  });

  it('handles array payloads deterministically', () => {
    expect(createFingerprint([{ id: 2 }, { id: 1 }])).toBe(
      createFingerprint([{ id: 2 }, { id: 1 }]),
    );
  });
});
