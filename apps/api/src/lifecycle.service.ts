import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { RemoteOperationService, type AppConfig, type OperationsRepository } from '@media-ingest/core';

import { APP_CONFIG, OPERATIONS_REPOSITORY } from './tokens';

@Injectable()
export class LifecycleService implements OnModuleInit, OnModuleDestroy {
  public constructor(
    @Inject(RemoteOperationService)
    private readonly operations: RemoteOperationService,
    @Inject(SchedulerRegistry)
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OPERATIONS_REPOSITORY) private readonly repository: OperationsRepository,
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.operations.initialize();
    await this.operations.resumeRecoverableOperations();
    const cleanupJob = new CronJob(this.config.storage.cleanupCron, async () => {
      await this.operations.cleanupExpiredOperations();
    });
    this.schedulerRegistry.addCronJob('cleanup-expired-operations', cleanupJob);
    cleanupJob.start();
  }

  public async onModuleDestroy(): Promise<void> {
    const cleanupJob = this.schedulerRegistry.getCronJob('cleanup-expired-operations');
    cleanupJob?.stop();
    await this.repository.close();
  }
}
