import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ZodError } from 'zod';

import {
  operationKinds,
  operationStatuses,
  providerIds,
  sourceKinds,
  RemoteOperationService,
  type AppConfig,
  type OperationKind,
  type OperationStatus,
  type ProviderId,
  type SourceKind,
} from '@media-ingest/core';

import { renderAdminPage } from './admin-ui';
import { APP_CONFIG } from './tokens';

function asOptionalEnum<T extends readonly string[]>(value: string | undefined, values: T): T[number] | undefined {
  if (!value) {
    return undefined;
  }
  if (!values.includes(value)) {
    throw new BadRequestException(`Unsupported value: ${value}`);
  }
  return value as T[number];
}

@Controller()
export class HealthController {
  public constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get('/healthz')
  public healthz() {
    return {
      status: 'ok',
      env: this.config.app.env,
    };
  }

  @Get('/admin')
  public admin(
    @Res()
    response: {
      type(contentType: string): { send(body: string): unknown };
      send?(body: string): unknown;
    },
  ) {
    response.type('html').send(renderAdminPage());
  }
}

@Controller('/v1')
export class OperationsController {
  public constructor(
    @Inject(RemoteOperationService)
    private readonly operations: RemoteOperationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('/transcriptions')
  @HttpCode(202)
  public async createTranscription(@Body() body: unknown) {
    try {
      return await this.operations.submitTranscription(body);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  @Post('/understanding')
  @HttpCode(202)
  public async createUnderstanding(@Body() body: unknown) {
    try {
      return await this.operations.submitUnderstanding(body);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  @Get('/operations/:operationId')
  public async getOperation(@Param('operationId') operationId: string) {
    try {
      return await this.operations.getOperationStatus(operationId);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  @Get('/admin/overview')
  public async getAdminOverview() {
    try {
      return await this.operations.getAdminOverview();
    } catch (error) {
      throw this.mapError(error);
    }
  }

  @Get('/admin/operations')
  public async listOperations(
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('provider') provider?: string,
    @Query('sourceType') sourceType?: string,
  ) {
    try {
      const parsedLimit = limit ? Number(limit) : 50;
      if (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
        throw new BadRequestException('limit must be between 1 and 200');
      }
      const items = await this.operations.listOperations({
        limit: parsedLimit,
        status: asOptionalEnum(status, operationStatuses) as OperationStatus | undefined,
        kind: asOptionalEnum(kind, operationKinds) as OperationKind | undefined,
        provider: asOptionalEnum(provider, providerIds) as ProviderId | undefined,
        sourceType: asOptionalEnum(sourceType, sourceKinds) as SourceKind | undefined,
      });
      return {
        items,
        meta: {
          limit: parsedLimit,
          count: items.length,
        },
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  private mapError(error: unknown): Error {
    if (error instanceof ZodError) {
      return new BadRequestException({
        message: 'Validation failed',
        issues: error.issues,
        pollAfterMs: this.config.app.pollAfterMs,
      });
    }
    if (error instanceof Error && error.message.startsWith('Operation not found')) {
      return new NotFoundException(error.message);
    }
    if (error instanceof Error) {
      return new BadRequestException(error.message);
    }
    return new BadRequestException('Unknown request failure');
  }
}
