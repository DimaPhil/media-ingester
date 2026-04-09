import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AppConfig } from '../config';
import {
  createAudioChunk,
  createVideoChunk,
  defaultChunkPath,
  planChunks,
  probeMedia,
  safeRemove,
  type MediaInspection,
} from '../media';
import type { ProviderRegistry } from '../providers';
import type { SourceRegistry } from '../sources';
import type { OperationResult, OperationStepName } from '../types';

import {
  type ChunkTranscript,
  type ChunkUnderstanding,
  type PipelineContext,
  type StepOutput,
  type StepStore,
  buildSteps,
  isTranscriptionStore,
  isUnderstandingStore,
  mergeSegments,
  mergeTimeRanges,
  restoreStepOutput,
  serializeError,
} from './shared';

export class PipelineRunner {
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
      const currentStep = steps.find((candidate) => stepMap.get(candidate)?.status !== 'completed') ?? null;
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
  ): Promise<StepOutput | null> {
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
        return { inspection, plannedChunks };
      }
      case 'run_chunks': {
        if (!context.materialized || !context.plannedChunks) {
          throw new Error('Chunks must be planned before run_chunks');
        }
        if (isTranscriptionStore(store)) {
          const provider = this.providers.transcriptionProvider(store.request.provider);
          const chunkTranscripts: ChunkTranscript[] = [];
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
              ...(store.request.inputLanguage ? { inputLanguage: store.request.inputLanguage } : {}),
              ...(store.request.model ? { model: store.request.model } : {}),
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

        if (!isUnderstandingStore(store)) {
          throw new Error('Understanding step received a non-understanding request');
        }
        const provider = this.providers.understandingProvider(store.request.provider);
        const chunkUnderstanding: ChunkUnderstanding[] = [];
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
            ...(store.request.model ? { model: store.request.model } : {}),
            prompt: store.request.prompt,
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
        if (isTranscriptionStore(store)) {
          const chunkTranscripts = context.chunkTranscripts ?? [];
          const segments = mergeSegments(chunkTranscripts);
          const sourceTranscript =
            segments.length > 0
              ? segments.map((segment) => segment.text).join(' ')
              : chunkTranscripts.map((chunk) => chunk.text).join(' ');
          const speakers = Array.from(
            new Set(segments.map((segment) => segment.speaker).filter(Boolean)),
          ).filter((speaker): speaker is string => Boolean(speaker));
          return {
            result: {
              kind: 'transcription',
              sourceLanguage: store.request.inputLanguage ?? null,
              detectedLanguage: chunkTranscripts.find((chunk) => chunk.detectedLanguage)?.detectedLanguage ?? null,
              targetLanguage: store.request.targetLanguage,
              sourceTranscript: sourceTranscript.trim(),
              translatedTranscript: undefined,
              segments,
              speakers: speakers.length > 0 ? speakers : undefined,
              provider: {
                id: store.request.provider,
                model: this.providers
                  .transcriptionProvider(store.request.provider)
                  .resolveModel(store.request.model),
                raw: chunkTranscripts.map((chunk) => chunk.raw),
              },
            },
          };
        }
        if (!isUnderstandingStore(store)) {
          throw new Error('Understanding step received a non-understanding request');
        }
        const chunkUnderstanding = context.chunkUnderstanding ?? [];
        return {
          result: {
            kind: 'understanding',
            prompt: store.request.prompt,
            responseText: chunkUnderstanding.map((chunk) => chunk.responseText).join('\n\n'),
            timeRanges: mergeTimeRanges(chunkUnderstanding),
            provider: {
              id: store.request.provider,
              model: this.providers
                .understandingProvider(store.request.provider)
                .resolveModel(store.request.model),
              raw: chunkUnderstanding.map((chunk) => chunk.raw),
            },
          },
        };
      }
      case 'translate_transcript': {
        if (!isTranscriptionStore(store) || !context.mergedResult || context.mergedResult.kind !== 'transcription') {
          throw new Error('translate_transcript can only run for transcriptions');
        }
        if (!store.request.targetLanguage) {
          return { translatedTranscript: null };
        }
        const translatedTranscript = await this.providers.translateWithBestAvailable({
          preferredProvider: store.request.provider,
          ...(store.request.model ? { model: store.request.model } : {}),
          text: context.mergedResult.sourceTranscript,
          targetLanguage: store.request.targetLanguage,
        });
        context.mergedResult = {
          ...context.mergedResult,
          translatedTranscript,
        };
        return { translatedTranscript };
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
