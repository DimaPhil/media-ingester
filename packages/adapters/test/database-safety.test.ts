import { describe, it, expect } from 'vitest';
import { requireDisposableDatabase } from '../../../test/support/database.js';
describe('disposable database guard', () => {
  it('rejects production names before opening SQL, including names merely containing test', () => {
    for (const name of ['production', 'latest', 'contest', 'testproduction', 'media_ingest'])
      expect(() => requireDisposableDatabase(`postgres://localhost/${name}`)).toThrow('disposable');
    for (const name of ['test', 'media_ingest_test', 'test-media'])
      expect(requireDisposableDatabase(`postgres://localhost/${name}`)).toContain(name);
  });
});
