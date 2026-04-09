import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  remoteTranscriptionRequestSchema,
  remoteUnderstandingRequestSchema,
  transcriptionRequestSchema,
  understandingRequestSchema,
  type TranscriptionRequest,
  type UnderstandingRequest,
} from './contracts';
import type { AppConfig } from './config';
import { createFingerprint } from './fingerprint';
import {
  createAudioChunk,
  createVideoChunk,
  defaultChunkPath,
  ensureDirectory,
  planChunks,
  probeMedia,
  safeRemove,
  type MediaInspection,
  type PlannedChunk,
} from './media';
import type { OperationsRepository, PersistedOperation } from './db';
import type { ProviderRegistry } from './providers';
import type { MaterializedSource, ResolvedSource } from './sources';
import type { SourceRegistry } from './sources';
import type {
  MediaSegment,
  OperationError,
  OperationKind,
  OperationProgress,
  OperationResult,
  OperationStatus,
  OperationStepName,
  OperationTimings,
  ProviderId,
  StepStatus,
  TimeRange,
} from './types';

type AnyRequest = TranscriptionRequest | UnderstandingRequest;

interface PipelineContext {
  resolvedSource?: ResolvedSource;
  inspection?: MediaInspection;
  materialized?: MaterializedSource;
  plannedChunks?: PlannedChunk[];
  chunkTranscripts?: Array<{
    index: number;
    startMs: number;
    endMs: number;
    text: string;
    detectedLanguage: string | null;
    segments: MediaSegment[];
    raw?: unknown;
  }>;
  chunkUnderstanding?: Array<{
    index: number;
    startMs: number;
    endMs: number;
    responseText: string;
    timeRanges?: TimeRange[];
    raw?: unknown;
  }>;
  mergedResult?: OperationResult;
  translatedTranscript?: string;
}

interface StepStore {
  readonly operationId: string;
  readonly kind: OperationKind;
  readonly request: AnyRequest;
  readonly workingDirectory: string;
  loadSteps(): Promise<Map<OperationStepName, PersistedOperationStepLike>>;
  setOperationState(patch: {
    status?: OperationStatus;
    currentStep?: OperationStepName | null;
    result?: OperationResult | null;
    error?: OperationError | null;
    retryable?: boolean;
    cacheHit?: boolean;
    startedAt?: Date | null;
    completedAt?: Date | null;
    expiresAt?: Date | null;
    lastHeartbeatAt?: Date | null;
  }): Promise<void>;
  saveStep(
    name: OperationStepName,
    order: number,
    patch: {
      status?: StepStatus;
      output?: Record<string, unknown> | null;
      error?: OperationError | null;
      attemptCount?: number;
      startedAt?: Date | null;
      completedAt?: Date | null;
    },
  ): Promise<PersistedOperationStepLike>;
}

interface PersistedOperationStepLike {
  name: OperationStepName;
  status: StepStatus;
  output: Record<string, unknown> | null;
  error: OperationError | null;
  attemptCount: number;
  startedAt: Date | null;
  completedAt: Date | null;
}

function serializeError(error: unknown): OperationError {
  if (error instanceof Error) {
    return {
      code: 'operation_failed',
      message: error.message,
      retryable: true,
    };
  }
  return {
    code: 'operation_failed',
    message: 'Unknown operation failure',
    retryable: true,
    details: error,
  };
}

function buildSteps(kind: OperationKind, request: AnyRequest): OperationStepName[] {
  const steps: OperationStepName[] = [
    'resolve_source',
    'inspect_media',
    'materialize_media',
    'plan_chunks',
    'run_chunks',
    'merge_chunks',
  ];
  if (kind === 'transcription' && 'targetLanguage' in request && request.targetLanguage) {
    steps.push('translate_transcript');
  }
  steps.push('finalize_result', 'cleanup');
  return steps;
}

function restoreStepOutput(context: PipelineContext, step: PersistedOperationStepLike): void {
  if (!step.output) {
    return;
  }
  switch (step.name) {
    case 'resolve_source':
      context.resolvedSource = step.output.resolvedSource as ResolvedSource;
      break;
    case 'inspect_media':
      context.inspection = step.output.inspection as MediaInspection;
      break;
    case 'materialize_media':
      context.materialized = step.output.materialized as MaterializedSource;
      break;
    case 'plan_chunks':
      context.inspection = step.output.inspection as MediaInspection;
      context.plannedChunks = step.output.plannedChunks as PlannedChunk[];
      break;
    case 'run_chunks':
      context.chunkTranscripts = step.output.chunkTranscripts as PipelineContext['chunkTranscripts'];
      context.chunkUnderstanding = step.output.chunkUnderstanding as PipelineContext['chunkUnderstanding'];
      break;
    case 'merge_chunks':
    case 'finalize_result':
      context.mergedResult = step.output.result as OperationResult;
      break;
    case 'translate_transcript':
      context.translatedTranscript = step.output.translatedTranscript as string;
      break;
    case 'cleanup':
      break;
  }
}

function mergeSegments(chunks: NonNullable<PipelineContext['chunkTranscripts']>): MediaSegment[] {
  const segments = chunks
    .flatMap((chunk) =>
      chunk.segments.map((segment) => ({
        ...segment,
        startMs: segment.startMs + chunk.startMs,
        endMs: segment.endMs + chunk.startMs,
      })),
    )
    .sort((left, right) => left.startMs - right.startMs);
  const merged: MediaSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous && segment.startMs < previous.endMs && segment.text === previous.text) {
      previous.endMs = Math.max(previous.endMs, segment.endMs);
      continue;
    }
    merged.push(segment);
  }
  return merged;
}

function mergeTimeRanges(chunks: NonNullable<PipelineContext['chunkUnderstanding']>): TimeRange[] {
  return chunks
    .flatMap((chunk) =>
      (chunk.timeRanges ?? []).map((range) => ({
        startMs: range.startMs + chunk.startMs,
        endMs: range.endMs + chunk.startMs,
        label: range.label,
      })),
    )
    .sort((left, right) => left.startMs - right.startMs);
}

class PipelineRunner {
  public constructor(
    private readonly config: AppConfig,
    private readonly sources: SourceRegistry,
    private readonly providers: ProviderRegistry,
  ) {}

  public async execute(store: StepStore): Promise<OperationResult> {
    const context: PipelineContext = {};
    const stepMap = await store.loadSteps();
    const steps = buildSteps(store.kind, store.request);

    await store.setOperationState({
      status: 'running',
      startedAt: new Date(),
      lastHeartbeatAt: new Date(),
    });

    try {
      for (const [index, stepName] of steps.entries()) {
        const existing = stepMap.get(stepName);
        if (existing?.status === 'completed') {
          restoreStepOutput(context, existing);
          continue;
        }
        await store.setOperationState({
          currentStep: stepName,
          lastHeartbeatAt: new Date(),
        });
        await store.saveStep(stepName, index, {
          status: 'running',
          attemptCount: (existing?.attemptCount ?? 0) + 1,
          startedAt: new Date(),
          error: null,
        });

        const output = await this.runStep(store, context, stepName);
        await store.saveStep(stepName, index, {
          status: 'completed',
          output,
          completedAt: new Date(),
          error: null,
        });
        restoreStepOutput(context, {
          name: stepName,
          status: 'completed',
          output,
          error: null,
          attemptCount: existing?.attemptCount ?? 1,
          startedAt: null,
          completedAt: new Date(),
        });
      }
    } catch (error) {
      const serializedError = serializeError(error);
      const currentStep = steps.find((stepName) => stepMap.get(stepName)?.status !== 'completed') ?? null;
      if (currentStep) {
        const existing = stepMap.get(currentStep);
        await store.saveStep(currentStep, steps.indexOf(currentStep), {
          status: 'failed',
          error: serializedError,
          attemptCount: (existing?.attemptCount ?? 0) + 1,
          completedAt: new Date(),
        });
      }
      await store.setOperationState({
        status: 'failed',
        error: serializedError,
        retryable: serializedError.retryable,
        completedAt: new Date(),
        expiresAt: new Date(
          Date.now() + this.config.storage.failedRetentionHours * 60 * 60 * 1000,
        ),
      });
      throw error;
    }

    if (!context.mergedResult) {
      throw new Error('Pipeline completed without a result');
    }

    await store.setOperationState({
      status: 'completed',
      result: context.mergedResult,
      error: null,
      retryable: false,
      currentStep: null,
      completedAt: new Date(),
      expiresAt: new Date(
        Date.now() + this.config.storage.completedRetentionHours * 60 * 60 * 1000,
      ),
      lastHeartbeatAt: new Date(),
    });
    return context.mergedResult;
  }

  private async runStep(
    store: StepStore,
    context: PipelineContext,
    stepName: OperationStepName,
  ): Promise<Record<string, unknown> | null> {
    switch (stepName) {
      case 'resolve_source': {
        const resolver = this.sources.resolverFor(store.request.source);
        const resolvedSource = await resolver.resolve(store.request.source);
        return { resolvedSource };
      }
      case 'inspect_media': {
        if (!context.resolvedSource) {
          throw new Error('Source must be resolved before inspect_media');
        }
        return {
          inspection: {
            path: '',
            formatName: null,
            durationMs: 0,
            sizeBytes: null,
            hasAudio: true,
            hasVideo: store.kind === 'understanding',
          } satisfies MediaInspection,
        };
      }
      case 'materialize_media': {
        if (!context.resolvedSource) {
          throw new Error('Source must be resolved before materialize_media');
        }
        const resolver = this.sources.resolverFor(store.request.source);
        const destinationDirectory = join(store.workingDirectory, 'source');
        await mkdir(destinationDirectory, { recursive: true });
        const materialized = await resolver.materialize(
          context.resolvedSource,
          destinationDirectory,
          store.kind,
        );
        return { materialized };
      }
      case 'plan_chunks': {
        if (!context.materialized) {
          throw new Error('Media must be materialized before plan_chunks');
        }
        const inspection = await probeMedia(context.materialized.localPath);
        const provider =
          store.kind === 'transcription'
            ? this.providers.transcriptionProvider(store.request.provider)
            : this.providers.understandingProvider(store.request.provider);
        const plannedChunks = planChunks(inspection, provider.capability(store.request.model));
        return {
          inspection,
          plannedChunks,
        };
      }
      case 'run_chunks': {
        if (!context.materialized || !context.plannedChunks) {
          throw new Error('Chunks must be planned before run_chunks');
        }
        if (store.kind === 'transcription') {
          const request = store.request as TranscriptionRequest;
          const provider = this.providers.transcriptionProvider(request.provider);
          const chunkTranscripts = [];
          for (const chunk of context.plannedChunks) {
            const chunkPath = defaultChunkPath(
              store.workingDirectory,
              store.operationId,
              chunk.index,
              'mp3',
            );
            await createAudioChunk(context.materialized.localPath, chunk, chunkPath);
            const result = await provider.transcribeChunk({
              filePath: chunkPath,
              ...(request.inputLanguage ? { inputLanguage: request.inputLanguage } : {}),
              ...(request.model ? { model: request.model } : {}),
            });
            chunkTranscripts.push({
              index: chunk.index,
              startMs: chunk.startMs,
              endMs: chunk.endMs,
              text: result.text,
              detectedLanguage: result.detectedLanguage,
              segments: result.segments,
              raw: result.raw,
            });
          }
          return { chunkTranscripts };
        }

        const request = store.request as UnderstandingRequest;
        const provider = this.providers.understandingProvider(request.provider);
        const chunkUnderstanding = [];
        for (const chunk of context.plannedChunks) {
          const chunkPath = defaultChunkPath(
            store.workingDirectory,
            store.operationId,
            chunk.index,
            'mp4',
          );
          await createVideoChunk(context.materialized.localPath, chunk, chunkPath);
          const result = await provider.understandChunk({
            filePath: chunkPath,
            ...(request.model ? { model: request.model } : {}),
            prompt: request.prompt,
          });
          chunkUnderstanding.push({
            index: chunk.index,
            startMs: chunk.startMs,
            endMs: chunk.endMs,
            responseText: result.responseText,
            timeRanges: result.timeRanges,
            raw: result.raw,
          });
        }
        return { chunkUnderstanding };
      }
      case 'merge_chunks': {
        if (store.kind === 'transcription') {
          const request = store.request as TranscriptionRequest;
          const chunkTranscripts = context.chunkTranscripts ?? [];
          const segments = mergeSegments(chunkTranscripts);
          const sourceTranscript =
            segments.length > 0
              ? segments.map((segment) => segment.text).join(' ')
              : chunkTranscripts.map((chunk) => chunk.text).join(' ');
          const speakers = Array.from(
            new Set(segments.map((segment) => segment.speaker).filter(Boolean)),
          ) as string[];
          const result: OperationResult = {
            kind: 'transcription',
            sourceLanguage: request.inputLanguage ?? null,
            detectedLanguage: chunkTranscripts.find((chunk) => chunk.detectedLanguage)?.detectedLanguage ?? null,
            targetLanguage: request.targetLanguage,
            sourceTranscript: sourceTranscript.trim(),
            translatedTranscript: undefined,
            segments,
            speakers: speakers.length > 0 ? speakers : undefined,
            provider: {
              id: request.provider,
              model: this.providers
                .transcriptionProvider(request.provider)
                .resolveModel(request.model),
              raw: chunkTranscripts.map((chunk) => chunk.raw),
            },
          };
          return { result };
        }
        const request = store.request as UnderstandingRequest;
        const chunkUnderstanding = context.chunkUnderstanding ?? [];
        const result: OperationResult = {
          kind: 'understanding',
          prompt: request.prompt,
          responseText: chunkUnderstanding.map((chunk) => chunk.responseText).join('\n\n'),
          timeRanges: mergeTimeRanges(chunkUnderstanding),
          provider: {
            id: request.provider,
            model: this.providers
              .understandingProvider(request.provider)
              .resolveModel(request.model),
            raw: chunkUnderstanding.map((chunk) => chunk.raw),
          },
        };
        return { result };
      }
      case 'translate_transcript': {
        if (store.kind !== 'transcription' || !context.mergedResult || context.mergedResult.kind !== 'transcription') {
          throw new Error('translate_transcript can only run for transcriptions');
        }
        const request = store.request as TranscriptionRequest;
        if (!request.targetLanguage) {
          return { translatedTranscript: null };
        }
        const translatedTranscript = await this.providers.translateWithBestAvailable({
          preferredProvider: request.provider,
          ...(request.model ? { model: request.model } : {}),
          text: context.mergedResult.sourceTranscript,
          targetLanguage: request.targetLanguage,
        });
        context.mergedResult = {
          ...context.mergedResult,
          translatedTranscript,
        };
        return {
          translatedTranscript,
        };
      }
      case 'finalize_result': {
        if (!context.mergedResult) {
          throw new Error('Result must be merged before finalize_result');
        }
        return { result: context.mergedResult };
      }
      case 'cleanup': {
        await safeRemove(store.workingDirectory);
        return { cleanedUp: true };
      }
    }
  }
}

class RemoteStepStore implements StepStore {
  public readonly operationId: string;
  public readonly kind: OperationKind;
  public readonly request: AnyRequest;
  public readonly workingDirectory: string;

  public constructor(
    private readonly repository: OperationsRepository,
    operation: PersistedOperation,
  ) {
    this.operationId = operation.id;
    this.kind = operation.kind;
    this.request = operation.input.request as AnyRequest;
    this.workingDirectory = operation.workingDirectory ?? join(process.cwd(), '.tmp', operation.id);
  }

  public async loadSteps(): Promise<Map<OperationStepName, PersistedOperationStepLike>> {
    const steps = await this.repository.listSteps(this.operationId);
    return new Map(steps.map((step) => [step.name, step]));
  }

  public async setOperationState(patch: {
    status?: OperationStatus;
    currentStep?: OperationStepName | null;
    result?: OperationResult | null;
    error?: OperationError | null;
    retryable?: boolean;
    cacheHit?: boolean;
    startedAt?: Date | null;
    completedAt?: Date | null;
    expiresAt?: Date | null;
    lastHeartbeatAt?: Date | null;
  }): Promise<void> {
    await this.repository.updateOperation(this.operationId, patch);
  }

  public async saveStep(
    name: OperationStepName,
    order: number,
    patch: {
      status?: StepStatus;
      output?: Record<string, unknown> | null;
      error?: OperationError | null;
      attemptCount?: number;
      startedAt?: Date | null;
      completedAt?: Date | null;
    },
  ): Promise<PersistedOperationStepLike> {
    return this.repository.saveStep(this.operationId, name, order, patch);
  }
}

class InMemoryStepStore implements StepStore {
  private readonly steps = new Map<OperationStepName, PersistedOperationStepLike>();

  public constructor(
    public readonly operationId: string,
    public readonly kind: OperationKind,
    public readonly request: AnyRequest,
    public readonly workingDirectory: string,
  ) {}

  public async loadSteps(): Promise<Map<OperationStepName, PersistedOperationStepLike>> {
    return this.steps;
  }

  public async setOperationState(): Promise<void> {}

  public async saveStep(
    name: OperationStepName,
    _order: number,
    patch: {
      status?: StepStatus;
      output?: Record<string, unknown> | null;
      error?: OperationError | null;
      attemptCount?: number;
      startedAt?: Date | null;
      completedAt?: Date | null;
    },
  ): Promise<PersistedOperationStepLike> {
    const step: PersistedOperationStepLike = {
      name,
      status: patch.status ?? 'pending',
      output: patch.output ?? null,
      error: patch.error ?? null,
      attemptCount: patch.attemptCount ?? 0,
      startedAt: patch.startedAt ?? null,
      completedAt: patch.completedAt ?? null,
    };
    this.steps.set(name, step);
    return step;
  }
}

export interface SubmitOperationResponse {
  operationId: string;
  status: OperationStatus;
  cacheHit: boolean;
  pollAfterMs: number;
  dedupeKey: string;
}

export interface OperationStatusView {
  operation: {
    id: string;
    kind: OperationKind;
    status: OperationStatus;
    provider: ProviderId;
    model: string | null;
    sourceType: string;
  };
  currentStep: OperationStepName | null;
  progress: OperationProgress;
  timings: OperationTimings;
  cacheHit: boolean;
  retryable: boolean;
  result?: OperationResult;
  error?: OperationError | null;
}

export interface OperationListItemView {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  provider: ProviderId;
  model: string | null;
  sourceType: string;
  sourceUri: string;
  currentStep: OperationStepName | null;
  cacheHit: boolean;
  retryable: boolean;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AdminOverviewView {
  counts: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    total: number;
  };
  activeOperations: number;
  latestFailures: OperationListItemView[];
  latestCompleted: OperationListItemView[];
}

export interface ListOperationsViewInput {
  limit?: number;
  status?: OperationStatus;
  kind?: OperationKind;
  provider?: ProviderId;
  sourceType?: 'youtube' | 'yt_dlp' | 'google_drive' | 'telegram' | 'http' | 'local_file';
}

function mapOperationListItem(operation: PersistedOperation): OperationListItemView {
  return {
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    provider: operation.provider,
    model: operation.model,
    sourceType: operation.sourceType,
    sourceUri: String(operation.sourceLocator.uri ?? ''),
    currentStep: operation.currentStep,
    cacheHit: operation.cacheHit,
    retryable: operation.retryable,
    errorMessage: operation.error?.message ?? null,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
    completedAt: operation.completedAt?.toISOString(),
  };
}

export class RemoteOperationService {
  private readonly runner: PipelineRunner;
  private readonly inFlight = new Map<string, Promise<void>>();

  public constructor(
    private readonly config: AppConfig,
    private readonly repository: OperationsRepository,
    private readonly sources: SourceRegistry,
    private readonly providers: ProviderRegistry,
  ) {
    this.runner = new PipelineRunner(config, sources, providers);
  }

  public async initialize(): Promise<void> {
    await this.repository.initialize();
    await ensureDirectory(this.config.storage.workingDirectory);
  }

  public async submitTranscription(input: unknown): Promise<SubmitOperationResponse> {
    const request = remoteTranscriptionRequestSchema.parse(input);
    return this.submitOperation('transcription', request);
  }

  public async submitUnderstanding(input: unknown): Promise<SubmitOperationResponse> {
    const request = remoteUnderstandingRequestSchema.parse(input);
    return this.submitOperation('understanding', request);
  }

  public async getOperationStatus(operationId: string): Promise<OperationStatusView> {
    const operation = await this.repository.findOperationById(operationId);
    if (!operation) {
      throw new Error(`Operation not found: ${operationId}`);
    }
    const steps = await this.repository.listSteps(operationId);
    const progress = {
      completedSteps: steps.filter((step) => step.status === 'completed').length,
      totalSteps: buildSteps(operation.kind, operation.input.request as AnyRequest).length,
      percentage:
        buildSteps(operation.kind, operation.input.request as AnyRequest).length === 0
          ? 0
          : Math.round(
              (steps.filter((step) => step.status === 'completed').length /
                buildSteps(operation.kind, operation.input.request as AnyRequest).length) *
                100,
            ),
      steps: steps.map((step) => ({
        name: step.name,
        status: step.status,
        startedAt: step.startedAt?.toISOString(),
        completedAt: step.completedAt?.toISOString(),
      })),
    } satisfies OperationProgress;
    return {
      operation: {
        id: operation.id,
        kind: operation.kind,
        status: operation.status,
        provider: operation.provider,
        model: operation.model,
        sourceType: operation.sourceType,
      },
      currentStep: operation.currentStep,
      progress,
      timings: {
        createdAt: operation.createdAt.toISOString(),
        startedAt: operation.startedAt?.toISOString(),
        completedAt: operation.completedAt?.toISOString(),
        updatedAt: operation.updatedAt.toISOString(),
      },
      cacheHit: operation.cacheHit,
      retryable: operation.retryable,
      result: operation.result ?? undefined,
      error: operation.error,
    };
  }

  public async listOperations(input: ListOperationsViewInput = {}): Promise<OperationListItemView[]> {
    const operations = await this.repository.listOperations(input);
    return operations.map(mapOperationListItem);
  }

  public async getAdminOverview(): Promise<AdminOverviewView> {
    const counts = await this.repository.getOperationCounts();
    const latestFailures = await this.repository.listOperations({
      status: 'failed',
      limit: 5,
    });
    const latestCompleted = await this.repository.listOperations({
      status: 'completed',
      limit: 5,
    });

    return {
      counts,
      activeOperations: counts.queued + counts.running,
      latestFailures: latestFailures.map(mapOperationListItem),
      latestCompleted: latestCompleted.map(mapOperationListItem),
    };
  }

  public async resumeRecoverableOperations(): Promise<void> {
    const operations = await this.repository.findRecoverableOperations();
    for (const operation of operations) {
      if (operation.status === 'queued' || operation.status === 'running') {
        this.queueOperation(operation.id);
      }
    }
  }

  public async cleanupExpiredOperations(): Promise<void> {
    const deleted = await this.repository.deleteExpiredOperations(new Date());
    for (const operation of deleted) {
      if (operation.workingDirectory) {
        await safeRemove(operation.workingDirectory);
      }
    }
  }

  private async submitOperation(
    kind: OperationKind,
    request: AnyRequest,
  ): Promise<SubmitOperationResponse> {
    const dedupeKey = createFingerprint({
      kind,
      request: {
        ...request,
        force: false,
      },
    });
    const cacheEnabled = this.config.features.cacheEnabled && !request.force;

    if (cacheEnabled) {
      return this.repository.withAdvisoryLock(`dedupe:${dedupeKey}`, async () => {
        const existing = await this.repository.findLatestByDedupeKey(dedupeKey);
        if (existing && (!existing.expiresAt || existing.expiresAt > new Date())) {
          if (existing.status === 'failed') {
            await this.repository.resetFailedSteps(existing.id);
            await this.repository.updateOperation(existing.id, {
              status: 'queued',
              error: null,
              retryable: true,
              cacheHit: true,
              completedAt: null,
            });
            this.queueOperation(existing.id);
          } else if (existing.status === 'queued' || existing.status === 'running') {
            this.queueOperation(existing.id);
          }
          return {
            operationId: existing.id,
            status: existing.status === 'failed' ? 'queued' : existing.status,
            cacheHit: true,
            pollAfterMs: this.config.app.pollAfterMs,
            dedupeKey,
          };
        }
        return this.createAndQueueOperation(kind, request, dedupeKey, cacheEnabled);
      });
    }

    return this.createAndQueueOperation(kind, request, dedupeKey, cacheEnabled);
  }

  private async createAndQueueOperation(
    kind: OperationKind,
    request: AnyRequest,
    dedupeKey: string,
    cacheEnabled: boolean,
  ): Promise<SubmitOperationResponse> {
    const operation = await this.repository.createOperation({
      dedupeKey,
      kind,
      provider: request.provider,
      model: request.model ?? null,
      sourceType: request.source.kind,
      sourceLocator: { uri: request.source.uri },
      input: {
        kind,
        request,
      },
      cacheEnabled,
      workingDirectory: null,
    });
    const workingDirectory = join(this.config.storage.workingDirectory, operation.id);
    await this.repository.updateOperation(operation.id, { workingDirectory });
    this.queueOperation(operation.id);
    return {
      operationId: operation.id,
      status: 'queued',
      cacheHit: false,
      pollAfterMs: this.config.app.pollAfterMs,
      dedupeKey,
    };
  }

  private queueOperation(operationId: string): void {
    if (this.inFlight.has(operationId)) {
      return;
    }
    const promise = (async () => {
      try {
        await this.processOperation(operationId);
      } catch {
        // Errors are persisted in operation state; keep background processing fire-and-forget.
      } finally {
        this.inFlight.delete(operationId);
      }
    })();
    this.inFlight.set(operationId, promise);
  }

  private async processOperation(operationId: string): Promise<void> {
    await this.repository.withAdvisoryLock(`operation:${operationId}`, async () => {
      const operation = await this.repository.findOperationById(operationId);
      if (!operation) {
        return;
      }
      const workingDirectory = operation.workingDirectory ?? join(this.config.storage.workingDirectory, operation.id);
      await ensureDirectory(workingDirectory);
      if (!operation.workingDirectory) {
        await this.repository.updateOperation(operation.id, { workingDirectory });
      }
      const store = new RemoteStepStore(this.repository, {
        ...operation,
        workingDirectory,
      });
      await this.runner.execute(store);
    });
  }
}

export class LocalMediaProcessor {
  private readonly runner: PipelineRunner;

  public constructor(
    private readonly config: AppConfig,
    private readonly sources: SourceRegistry,
    private readonly providers: ProviderRegistry,
  ) {
    this.runner = new PipelineRunner(config, sources, providers);
  }

  public async transcribe(input: unknown): Promise<OperationResult> {
    const request = transcriptionRequestSchema.parse(input);
    if (request.source.kind !== 'local_file') {
      throw new Error('Local processor only accepts local_file sources');
    }
    const workingDirectory = join(
      this.config.storage.workingDirectory,
      `local-${Date.now().toString(36)}`,
    );
    await ensureDirectory(workingDirectory);
    const store = new InMemoryStepStore(
      `local-${Date.now().toString(36)}`,
      'transcription',
      request,
      workingDirectory,
    );
    return this.runner.execute(store);
  }

  public async understand(input: unknown): Promise<OperationResult> {
    const request = understandingRequestSchema.parse(input);
    if (request.source.kind !== 'local_file') {
      throw new Error('Local processor only accepts local_file sources');
    }
    const workingDirectory = join(
      this.config.storage.workingDirectory,
      `local-${Date.now().toString(36)}`,
    );
    await ensureDirectory(workingDirectory);
    const store = new InMemoryStepStore(
      `local-${Date.now().toString(36)}`,
      'understanding',
      request,
      workingDirectory,
    );
    return this.runner.execute(store);
  }
}
