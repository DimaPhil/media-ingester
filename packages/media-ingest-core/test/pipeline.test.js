"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_util_1 = require("node:util");
const node_child_process_1 = require("node:child_process");
const vitest_1 = require("vitest");
const pipeline_1 = require("../src/pipeline");
const fingerprint_1 = require("../src/fingerprint");
const execFile = (0, node_util_1.promisify)(node_child_process_1.execFile);
async function createAudioFixture(durationSeconds = 2) {
    const directory = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'media-ingest-audio-'));
    const path = (0, node_path_1.join)(directory, 'fixture.mp3');
    await execFile('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=1000:duration=${durationSeconds}`,
        '-q:a',
        '9',
        '-acodec',
        'libmp3lame',
        path,
    ]);
    return path;
}
async function createVideoFixture(durationSeconds = 1) {
    const directory = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'media-ingest-video-'));
    const path = (0, node_path_1.join)(directory, 'fixture.mp4');
    await execFile('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc=size=320x240:rate=25:duration=${durationSeconds}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=500:duration=${durationSeconds}`,
        '-shortest',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        path,
    ]);
    return path;
}
async function waitFor(producer, predicate) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        const value = await producer();
        if (predicate(value)) {
            return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for condition');
}
class InMemoryRepository {
    operations = new Map();
    steps = new Map();
    nextId = 1;
    async initialize() { }
    async close() { }
    async withAdvisoryLock(_key, callback) {
        return await callback();
    }
    async createOperation(input) {
        const id = `op-${this.nextId++}`;
        const now = new Date();
        const operation = {
            id,
            ...input,
            status: 'queued',
            result: null,
            error: null,
            cacheHit: false,
            retryable: true,
            currentStep: null,
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            completedAt: null,
            expiresAt: null,
            lastHeartbeatAt: null,
        };
        this.operations.set(id, operation);
        this.steps.set(id, new Map());
        return operation;
    }
    async updateOperation(id, patch) {
        const current = this.operations.get(id);
        if (!current) {
            throw new Error(`Operation not found: ${id}`);
        }
        const next = {
            ...current,
            ...patch,
            updatedAt: new Date(),
        };
        this.operations.set(id, next);
        return next;
    }
    async findOperationById(id) {
        return this.operations.get(id) ?? null;
    }
    async findLatestByDedupeKey(dedupeKey) {
        return Array.from(this.operations.values())
            .filter((operation) => operation.dedupeKey === dedupeKey)
            .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
    }
    async findRecoverableOperations() {
        return Array.from(this.operations.values()).filter((operation) => ['queued', 'running', 'failed'].includes(operation.status));
    }
    async listSteps(operationId) {
        return Array.from(this.steps.get(operationId)?.values() ?? []).sort((left, right) => left.stepOrder - right.stepOrder);
    }
    async saveStep(operationId, name, stepOrder, patch) {
        const operationSteps = this.steps.get(operationId);
        if (!operationSteps) {
            throw new Error(`Missing steps for ${operationId}`);
        }
        const current = operationSteps.get(name);
        const next = {
            name,
            operationId,
            stepOrder,
            status: patch.status ?? current?.status ?? 'pending',
            attemptCount: patch.attemptCount ?? current?.attemptCount ?? 0,
            output: patch.output ?? current?.output ?? null,
            error: patch.error ?? current?.error ?? null,
            startedAt: patch.startedAt ?? current?.startedAt ?? null,
            completedAt: patch.completedAt ?? current?.completedAt ?? null,
        };
        operationSteps.set(name, next);
        return next;
    }
    async resetFailedSteps(operationId) {
        const operationSteps = this.steps.get(operationId);
        if (!operationSteps) {
            return;
        }
        for (const [name, step] of operationSteps.entries()) {
            if (step.status === 'failed') {
                operationSteps.set(name, {
                    ...step,
                    status: 'pending',
                    error: null,
                    startedAt: null,
                    completedAt: null,
                });
            }
        }
    }
    async deleteExpiredOperations(now) {
        const expired = Array.from(this.operations.values()).filter((operation) => operation.expiresAt && operation.expiresAt <= now);
        for (const operation of expired) {
            this.operations.delete(operation.id);
            this.steps.delete(operation.id);
        }
        return expired;
    }
}
function createConfig() {
    return {
        app: {
            env: 'test',
            host: '127.0.0.1',
            port: 3000,
            pollAfterMs: 5,
        },
        features: {
            cacheEnabled: true,
        },
        storage: {
            workingDirectory: (0, node_path_1.join)((0, node_os_1.tmpdir)(), 'media-ingest-tests'),
            completedRetentionHours: 1,
            failedRetentionHours: 1,
            cleanupCron: '0 * * * *',
            ytDlpCookiesPath: '',
        },
        database: {
            url: 'postgres://unused',
        },
        providers: {
            openai: {
                enabled: true,
                apiKey: '',
                baseUrl: 'https://api.openai.com/v1',
                defaultModel: 'gpt-4o-transcribe',
                diarizeModel: 'gpt-4o-transcribe',
                translationModel: 'gpt-4.1-mini',
            },
            google: {
                enabled: true,
                apiKey: '',
                projectId: '',
                location: 'global',
                geminiTranscriptionModel: 'gemini-2.5-flash',
                geminiUnderstandingModel: 'gemini-2.5-pro',
                speechRecognizer: 'projects/_/locations/global/recognizers/_',
                serviceAccountJson: '',
            },
        },
        sources: {
            googleDrive: { enabled: true },
            telegram: { enabled: true, baseUrl: 'http://localhost:8080', bearerToken: '' },
            ytDlp: { enabled: true, binaryPath: 'yt-dlp' },
            http: { enabled: true, timeoutMs: 1000 },
        },
    };
}
(0, vitest_1.describe)('RemoteOperationService', () => {
    const createdFiles = [];
    (0, vitest_1.afterEach)(async () => {
        for (const file of createdFiles) {
            await (0, promises_1.rm)((0, node_path_1.dirname)(file), { force: true, recursive: true }).catch(() => undefined);
        }
        createdFiles.length = 0;
    });
    (0, vitest_1.it)('processes a transcription request and reuses the completed operation from cache', async () => {
        const fixturePath = await createAudioFixture();
        createdFiles.push(fixturePath);
        const repository = new InMemoryRepository();
        let chunkIndex = 0;
        const service = new pipeline_1.RemoteOperationService(createConfig(), repository, {
            resolverFor: () => ({
                resolve: async () => ({
                    kind: 'http',
                    canonicalUri: 'https://example.com/audio.mp3',
                    displayName: 'Example',
                    fileName: 'audio.mp3',
                    metadata: {},
                }),
                materialize: async () => ({
                    localPath: fixturePath,
                    fileName: 'audio.mp3',
                }),
            }),
        }, {
            transcriptionProvider: () => ({
                resolveModel: () => 'fake-model',
                capability: () => ({
                    maxWholeFileDurationMs: 500,
                    chunkDurationMs: 500,
                    overlapMs: 0,
                }),
                transcribeChunk: async () => {
                    const index = chunkIndex++;
                    return {
                        text: `chunk-${index}`,
                        detectedLanguage: 'en',
                        segments: [
                            {
                                startMs: 0,
                                endMs: 300,
                                text: `chunk-${index}`,
                            },
                        ],
                    };
                },
                translateText: async ({ text }) => `translated:${text}`,
            }),
            translateWithBestAvailable: async ({ text }) => `translated:${text}`,
        });
        await service.initialize();
        const first = await service.submitTranscription({
            source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
            provider: 'openai',
            targetLanguage: 'de',
            force: false,
        });
        const firstStatus = await waitFor(() => service.getOperationStatus(first.operationId), (value) => value.operation.status === 'completed');
        (0, vitest_1.expect)(firstStatus.result).toMatchObject({
            kind: 'transcription',
            translatedTranscript: vitest_1.expect.stringContaining('translated:'),
        });
        const second = await service.submitTranscription({
            source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
            provider: 'openai',
            targetLanguage: 'de',
            force: false,
        });
        (0, vitest_1.expect)(second.cacheHit).toBe(true);
        (0, vitest_1.expect)(second.operationId).toBe(first.operationId);
    });
    (0, vitest_1.it)('resumes a failed operation from the same operation id when retried', async () => {
        const fixturePath = await createAudioFixture();
        createdFiles.push(fixturePath);
        const repository = new InMemoryRepository();
        const config = createConfig();
        const dedupeKey = (0, fingerprint_1.createFingerprint)({
            kind: 'transcription',
            request: {
                source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
                provider: 'openai',
                force: false,
            },
        });
        const service = new pipeline_1.RemoteOperationService(config, repository, {
            resolverFor: () => ({
                resolve: async () => ({
                    kind: 'http',
                    canonicalUri: 'https://example.com/audio.mp3',
                    displayName: 'Example',
                    fileName: 'audio.mp3',
                    metadata: {},
                }),
                materialize: async () => ({
                    localPath: fixturePath,
                    fileName: 'audio.mp3',
                }),
            }),
        }, {
            transcriptionProvider: () => ({
                resolveModel: () => 'fake-model',
                capability: () => ({
                    maxWholeFileDurationMs: 60_000,
                    chunkDurationMs: 60_000,
                    overlapMs: 0,
                }),
                transcribeChunk: async () => ({
                    text: 'recovered',
                    detectedLanguage: 'en',
                    segments: [{ startMs: 0, endMs: 500, text: 'recovered' }],
                }),
            }),
            translateWithBestAvailable: async () => '',
        });
        await service.initialize();
        const prepared = await repository.createOperation({
            dedupeKey,
            kind: 'transcription',
            provider: 'openai',
            model: null,
            sourceType: 'http',
            sourceLocator: { uri: 'https://example.com/audio.mp3' },
            input: {
                kind: 'transcription',
                request: {
                    source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
                    provider: 'openai',
                    force: false,
                },
            },
            cacheEnabled: true,
            workingDirectory: (0, node_path_1.join)(config.storage.workingDirectory, 'resume-op'),
        });
        await repository.saveStep(prepared.id, 'resolve_source', 0, {
            status: 'completed',
            attemptCount: 1,
            output: {
                resolvedSource: {
                    kind: 'http',
                    canonicalUri: 'https://example.com/audio.mp3',
                    displayName: 'Example',
                    fileName: 'audio.mp3',
                    metadata: {},
                },
            },
        });
        await repository.saveStep(prepared.id, 'run_chunks', 4, {
            status: 'failed',
            attemptCount: 1,
            error: {
                code: 'temporary',
                message: 'temporary provider failure',
                retryable: true,
            },
        });
        await repository.updateOperation(prepared.id, {
            status: 'failed',
            error: {
                code: 'temporary',
                message: 'temporary provider failure',
                retryable: true,
            },
            workingDirectory: (0, node_path_1.join)(config.storage.workingDirectory, prepared.id),
        });
        const retry = await service.submitTranscription({
            source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
            provider: 'openai',
            force: false,
        });
        (0, vitest_1.expect)(retry.operationId).toBe(prepared.id);
        const recovered = await waitFor(() => service.getOperationStatus(prepared.id), (value) => value.operation.status === 'completed');
        (0, vitest_1.expect)(recovered.result).toMatchObject({
            kind: 'transcription',
            sourceTranscript: 'recovered',
        });
    });
    (0, vitest_1.it)('processes an understanding request through the understanding provider branch', async () => {
        const fixturePath = await createVideoFixture();
        createdFiles.push(fixturePath);
        const repository = new InMemoryRepository();
        const service = new pipeline_1.RemoteOperationService(createConfig(), repository, {
            resolverFor: () => ({
                resolve: async () => ({
                    kind: 'http',
                    canonicalUri: 'https://example.com/video.mp4',
                    displayName: 'Example video',
                    fileName: 'video.mp4',
                    metadata: {},
                }),
                materialize: async () => ({
                    localPath: fixturePath,
                    fileName: 'video.mp4',
                }),
            }),
        }, {
            understandingProvider: () => ({
                resolveModel: () => 'gemini-test',
                capability: () => ({
                    maxWholeFileDurationMs: 60_000,
                    chunkDurationMs: 60_000,
                    overlapMs: 0,
                }),
                understandChunk: async () => ({
                    responseText: 'understood',
                    timeRanges: [{ startMs: 0, endMs: 500, label: 'intro' }],
                }),
            }),
        });
        await service.initialize();
        const submitted = await service.submitUnderstanding({
            source: { kind: 'http', uri: 'https://example.com/video.mp4' },
            provider: 'google-gemini',
            prompt: 'Summarize the clip',
            force: false,
        });
        const status = await waitFor(() => service.getOperationStatus(submitted.operationId), (value) => value.operation.status === 'completed');
        (0, vitest_1.expect)(status.result).toMatchObject({
            kind: 'understanding',
            responseText: 'understood',
        });
    });
    (0, vitest_1.it)('cleans up expired operations and their working directories', async () => {
        const repository = new InMemoryRepository();
        const config = createConfig();
        const service = new pipeline_1.RemoteOperationService(config, repository, { resolverFor: () => ({}) }, {});
        const workingDirectory = (0, node_path_1.join)(config.storage.workingDirectory, 'expired-op');
        await (0, promises_1.rm)(workingDirectory, { force: true, recursive: true }).catch(() => undefined);
        await execFile('mkdir', ['-p', workingDirectory]);
        const operation = await repository.createOperation({
            dedupeKey: 'expired',
            kind: 'transcription',
            provider: 'openai',
            model: null,
            sourceType: 'http',
            sourceLocator: { uri: 'https://example.com/audio.mp3' },
            input: { kind: 'transcription', request: { force: false } },
            cacheEnabled: true,
            workingDirectory,
        });
        await repository.updateOperation(operation.id, {
            expiresAt: new Date(Date.now() - 1_000),
        });
        await service.cleanupExpiredOperations();
        (0, vitest_1.expect)(await repository.findOperationById(operation.id)).toBeNull();
        await (0, vitest_1.expect)(execFile('test', ['-d', workingDirectory])).rejects.toBeTruthy();
    });
});
(0, vitest_1.describe)('LocalMediaProcessor', () => {
    (0, vitest_1.it)('processes local files without persistent jobs', async () => {
        const fixturePath = await createAudioFixture();
        const config = createConfig();
        const processor = new pipeline_1.LocalMediaProcessor(config, {
            resolverFor: () => ({
                resolve: async () => ({
                    kind: 'local_file',
                    canonicalUri: fixturePath,
                    displayName: 'Local fixture',
                    fileName: 'fixture.mp3',
                    metadata: {},
                }),
                materialize: async () => ({
                    localPath: fixturePath,
                    fileName: 'fixture.mp3',
                }),
            }),
        }, {
            transcriptionProvider: () => ({
                resolveModel: () => 'local-model',
                capability: () => ({
                    maxWholeFileDurationMs: 60_000,
                    chunkDurationMs: 60_000,
                    overlapMs: 0,
                }),
                transcribeChunk: async () => ({
                    text: 'local transcript',
                    detectedLanguage: 'en',
                    segments: [{ startMs: 0, endMs: 250, text: 'local transcript' }],
                }),
            }),
            translateWithBestAvailable: async () => '',
        });
        const result = await processor.transcribe({
            source: {
                kind: 'local_file',
                uri: fixturePath,
            },
            provider: 'openai',
            force: true,
        });
        (0, vitest_1.expect)(result).toMatchObject({
            kind: 'transcription',
            sourceTranscript: 'local transcript',
        });
        await (0, promises_1.rm)((0, node_path_1.dirname)(fixturePath), { force: true, recursive: true }).catch(() => undefined);
    });
});
//# sourceMappingURL=pipeline.test.js.map