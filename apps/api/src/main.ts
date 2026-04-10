import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { loadAppConfig } from '@media-ingest/core';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const config = loadAppConfig();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(config.app.port, config.app.host);
}

void bootstrap();
