import { join } from 'node:path';

import type { OperationsRepository, PersistedOperation } from '../db';
import type {
  OperationError,
  OperationKind,
  OperationResult,
  OperationStatus,
  OperationStepName,
  StepStatus,
} from '../types';

import {
  type AnyRequest,
  type PersistedOperationStepLike,
  type StepOutput,
  type StepStore,
  getOperationRequest,
  toStepMap,
} from './shared';

export class RemoteStepStore implements StepStore {
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
    this.request = getOperationRequest(operation.input);
    this.workingDirectory = operation.workingDirectory ?? join(process.cwd(), '.tmp', operation.id);
  }

  public async loadSteps(): Promise<Map<OperationStepName, PersistedOperationStepLike>> {
    return toStepMap(await this.repository.listSteps(this.operationId));
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
      output?: StepOutput | null;
      error?: OperationError | null;
      attemptCount?: number;
      startedAt?: Date | null;
      completedAt?: Date | null;
    },
  ): Promise<PersistedOperationStepLike> {
    return this.repository.saveStep(this.operationId, name, order, patch);
  }
}

export class InMemoryStepStore implements StepStore {
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
      output?: StepOutput | null;
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
