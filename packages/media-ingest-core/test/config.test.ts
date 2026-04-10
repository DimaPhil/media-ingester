import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadAppConfig } from '../src/config';

describe.skip('loadAppConfig', () => {
  it('loads yaml values and env overrides', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-ingest-config-'));
    const configPath = join(directory, 'app.yaml');
    await writeFile(
      configPath,
      [
        'app:',
        '  env: test',
        '  port: 4010',
        'storage:',
        '  workingDirectory: ./tmp-files',
        'database:',
        '  url: postgres://from-file',
        'providers:',
        '  openai:',
        '    enabled: true',
        '    apiKey: from-file',
        '  google:',
        '    enabled: true',
        'sources:',
        '  googleDrive:',
        '    enabled: true',
        '  telegram:',
        '    enabled: true',
        '    baseUrl: http://localhost:4040',
        '  ytDlp:',
        '    enabled: true',
        '  http:',
        '    enabled: true',
      ].join('\n'),
    );

    const config = loadAppConfig({
      configPath,
      env: {
        ...process.env,
        OPENAI_API_KEY: 'from-env',
        DATABASE_URL: 'postgres://from-env',
      },
    });

    expect(config.app.env).toBe('test');
    expect(config.app.port).toBe(4010);
    expect(config.providers.openai.apiKey).toBe('from-env');
    expect(config.database.url).toBe('postgres://from-env');
    expect(config.storage.workingDirectory).toBe(join(directory, 'tmp-files'));
  });
});
