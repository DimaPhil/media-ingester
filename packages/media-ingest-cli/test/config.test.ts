import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadCliConfig } from '../src/config';

describe('loadCliConfig', () => {
  it('loads CLI config from disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-ingest-cli-'));
    const configPath = join(directory, 'env.json');
    await writeFile(
      configPath,
      JSON.stringify({
        apiBaseUrl: 'http://localhost:3000',
        apiToken: 'secret',
      }),
    );

    await expect(loadCliConfig(configPath)).resolves.toEqual({
      apiBaseUrl: 'http://localhost:3000',
      apiToken: 'secret',
    });
  });

  it('returns an empty object when config is missing', async () => {
    await expect(loadCliConfig('/path/that/does/not/exist.json')).resolves.toEqual({});
  });
});
