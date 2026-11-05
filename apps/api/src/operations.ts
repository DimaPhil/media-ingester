import { createHash, randomUUID } from 'node:crypto';
import {
  contractDocument,
  MAX_INLINE_MEDIA_BYTES,
  operations,
  RELEASE_VERSION,
  type OperationId,
} from '@media-ingest/contracts';
import {
  MediaError,
  type MediaSdk,
  type SourceAdapter,
  type MediaAdapter,
  type AdapterContext,
  type Artifact,
} from '@media-ingest/sdk';

export const contractHash = createHash('sha256')
  .update(JSON.stringify(contractDocument()))
  .digest('hex');

export interface OperationDependencies {
  sdk: Pick<MediaSdk, 'submit' | 'get' | 'list' | 'retry' | 'history' | 'getResult'>;
  sources: SourceAdapter;
  media: Pick<MediaAdapter, 'cleanup'>;
  files: {
    upload(ownerId: string, fileName: string, data: string): Promise<unknown>;
    readArtifact(artifact: Artifact, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
  };
}

function sourceContext(ownerId: string): AdapterContext {
  return { ownerId, jobId: randomUUID(), attempt: 0, signal: AbortSignal.timeout(120000) };
}

export type OperationDispatcher = ReturnType<typeof createDispatcher>;

export function createDispatcher(options: OperationDependencies) {
  return async (
    ownerId: string,
    scopes: string[],
    id: OperationId,
    input: unknown,
  ): Promise<unknown> => {
    const operation = operations[id];
    if (operation.scope !== null && !scopes.includes(operation.scope))
      throw new MediaError('forbidden', 'Required scope was not granted');
    let output: unknown;
    switch (id) {
      case 'submit': {
        const value = operations.submit.input.parse(input);
        output = await options.sdk.submit(ownerId, value.request, value.idempotencyKey);
        break;
      }
      case 'get':
        output = await options.sdk.get(ownerId, operations.get.input.parse(input).id);
        break;
      case 'list':
        output = { items: await options.sdk.list(ownerId, operations.list.input.parse(input)) };
        break;
      case 'retry':
        output = await options.sdk.retry(ownerId, operations.retry.input.parse(input).id);
        break;
      case 'history':
        output = await options.sdk.history(ownerId, operations.history.input.parse(input));
        break;
      case 'result':
        output = await options.sdk.getResult(ownerId, operations.result.input.parse(input).id);
        break;
      case 'info':
        operations.info.input.parse(input);
        output = { version: RELEASE_VERSION, contractHash };
        break;
      case 'upload': {
        const value = operations.upload.input.parse(input);
        output = await options.files.upload(ownerId, value.fileName, value.data);
        break;
      }
      case 'resolve': {
        const context = sourceContext(ownerId);
        output = await options.sources.resolve(
          operations.resolve.input.parse(input).source,
          context,
        );
        break;
      }
      case 'download': {
        const { source } = operations.download.input.parse(input);
        const context = sourceContext(ownerId);
        try {
          const resolved = await options.sources.resolve(source, context);
          const artifact = await options.sources.materialize(resolved, context);
          const bytes = await options.files.readArtifact(
            artifact,
            MAX_INLINE_MEDIA_BYTES,
            context.signal,
          );
          output = {
            fileName: artifact.fileName,
            data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
            mimeType: artifact.mimeType,
          };
        } finally {
          await options.media.cleanup(context);
        }
        break;
      }
      default:
        throw new Error(`Unknown operation: ${id satisfies never}`);
    }
    const validated = operation.output.safeParse(output);
    if (!validated.success) throw new Error('Operation produced an invalid response');
    return validated.data;
  };
}
