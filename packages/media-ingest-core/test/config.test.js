"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const vitest_1 = require("vitest");
const config_1 = require("../src/config");
vitest_1.describe.skip('loadAppConfig', () => {
    (0, vitest_1.it)('loads yaml values and env overrides', async () => {
        const directory = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'media-ingest-config-'));
        const configPath = (0, node_path_1.join)(directory, 'app.yaml');
        await (0, promises_1.writeFile)(configPath, [
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
            '    baseUrl: http://localhost:8080',
            '  ytDlp:',
            '    enabled: true',
            '  http:',
            '    enabled: true',
        ].join('\n'));
        const config = (0, config_1.loadAppConfig)({
            configPath,
            env: {
                ...process.env,
                OPENAI_API_KEY: 'from-env',
                DATABASE_URL: 'postgres://from-env',
            },
        });
        (0, vitest_1.expect)(config.app.env).toBe('test');
        (0, vitest_1.expect)(config.app.port).toBe(4010);
        (0, vitest_1.expect)(config.providers.openai.apiKey).toBe('from-env');
        (0, vitest_1.expect)(config.database.url).toBe('postgres://from-env');
        (0, vitest_1.expect)(config.storage.workingDirectory).toBe((0, node_path_1.join)(directory, 'tmp-files'));
    });
});
//# sourceMappingURL=config.test.js.map