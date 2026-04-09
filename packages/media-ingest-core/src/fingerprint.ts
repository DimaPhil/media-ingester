import { createHash } from 'node:crypto';

function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableSort);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((accumulator, key) => {
      accumulator[key] = stableSort((value as Record<string, unknown>)[key]);
      return accumulator;
    }, {});
}

export function createFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableSort(value)))
    .digest('hex');
}
