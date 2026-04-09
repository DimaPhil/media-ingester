import { Module } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  ProviderRegistry,
  RemoteOperationService,
  SourceRegistry,
  OperationsRepository,
  createDatabase,
  loadAppConfig,
  type AppConfig,
  type DatabaseHandle,
} from '@media-ingest/core';

import { HealthController, OperationsController } from './controllers';
import { LifecycleService } from './lifecycle.service';
import { APP_CONFIG, DATABASE, OPERATIONS_REPOSITORY } from './tokens';

@Module({
  controllers: [HealthController, OperationsController],
  providers: [
    SchedulerRegistry,
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadAppConfig(),
    },
    {
      provide: DATABASE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): DatabaseHandle => createDatabase(config.database.url),
    },
    {
      provide: OPERATIONS_REPOSITORY,
      inject: [DATABASE],
      useFactory: (database: DatabaseHandle): OperationsRepository =>
        new OperationsRepository(database),
    },
    {
      provide: SourceRegistry,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): SourceRegistry => new SourceRegistry(config),
    },
    {
      provide: ProviderRegistry,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): ProviderRegistry => new ProviderRegistry(config),
    },
    {
      provide: RemoteOperationService,
      inject: [APP_CONFIG, OPERATIONS_REPOSITORY, SourceRegistry, ProviderRegistry],
      useFactory: (
        config: AppConfig,
        repository: OperationsRepository,
        sources: SourceRegistry,
        providers: ProviderRegistry,
      ): RemoteOperationService =>
        new RemoteOperationService(config, repository, sources, providers),
    },
    LifecycleService,
  ],
})
export class AppModule {}
