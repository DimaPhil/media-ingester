"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = require("node:crypto");
const vitest_1 = require("vitest");
const db_1 = require("../src/db");
const databaseUrl = process.env.DATABASE_URL;
const describeIfDatabase = databaseUrl ? vitest_1.describe : vitest_1.describe.skip;
describeIfDatabase('OperationsRepository integration', () => {
    let repository;
    (0, vitest_1.beforeAll)(async () => {
        repository = new db_1.OperationsRepository((0, db_1.createDatabase)(databaseUrl));
        await repository.initialize();
    });
    (0, vitest_1.afterAll)(async () => {
        await repository.close();
    });
    (0, vitest_1.it)('persists operations and step state', async () => {
        const dedupeKey = (0, node_crypto_1.randomUUID)();
        const operation = await repository.createOperation({
            dedupeKey,
            kind: 'transcription',
            provider: 'openai',
            model: null,
            sourceType: 'http',
            sourceLocator: { uri: 'https://example.com' },
            input: { kind: 'transcription', request: { force: false } },
            cacheEnabled: true,
            workingDirectory: '/tmp/media-ingest',
        });
        await repository.saveStep(operation.id, 'resolve_source', 0, {
            status: 'completed',
            output: { ok: true },
            attemptCount: 1,
            completedAt: new Date(),
        });
        await repository.updateOperation(operation.id, {
            status: 'completed',
            result: {
                kind: 'transcription',
                sourceLanguage: 'en',
                detectedLanguage: 'en',
                sourceTranscript: 'hello',
                segments: [],
                provider: { id: 'openai', model: 'gpt-4o-transcribe' },
            },
            completedAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
        });
        const loaded = await repository.findLatestByDedupeKey(dedupeKey);
        const steps = await repository.listSteps(operation.id);
        (0, vitest_1.expect)(loaded?.status).toBe('completed');
        (0, vitest_1.expect)(steps).toHaveLength(1);
        (0, vitest_1.expect)(steps[0]?.status).toBe('completed');
    });
});
//# sourceMappingURL=db.integration.test.js.map