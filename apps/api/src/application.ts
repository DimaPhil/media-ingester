import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  contractDocument,
  operationIds,
  operations,
  openApiDocument,
  RELEASE_VERSION,
  type OperationId,
  type Source,
} from '@media-ingest/contracts';
import {
  MediaError,
  type MediaSdk,
  type SourceAdapter,
  type MediaAdapter,
  type AdapterContext,
} from '@media-ingest/sdk';
import { createAuth, type AuthStore, type Identity } from './auth/index.js';

export const contractHash = createHash('sha256')
  .update(JSON.stringify(contractDocument()))
  .digest('hex');
export interface ApplicationOptions {
  sdk: MediaSdk;
  sources: SourceAdapter;
  media: MediaAdapter;
  files: { upload(ownerId: string, fileName: string, data: string): Promise<unknown> };
  authStore: AuthStore;
  publicUrl: string;
  ownerToken: string;
  allowedOrigins?: string[];
  logger?: (error: unknown) => void;
}

export function createApplication(options: ApplicationOptions) {
  const origin = new URL(options.publicUrl).origin;
  const auth = createAuth({
    publicUrl: options.publicUrl,
    ownerToken: options.ownerToken,
    store: options.authStore,
  });
  const app = new Hono<{ Variables: { identity: Identity } }>();
  const report = options.logger ?? (() => {});
  const dispatch = async (
    ownerId: string,
    scopes: string[],
    id: OperationId,
    input: unknown,
  ): Promise<unknown> => {
    const operation = operations[id];
    if (operation.scope !== null && !scopes.includes(operation.scope))
      throw new MediaError('forbidden', 'Required scope was not granted');
    const data = operation.input.parse(input);
    let output: unknown;
    switch (id) {
      case 'submit': {
        const value = operations.submit.input.parse(data);
        output = await options.sdk.submit(ownerId, value.request, value.idempotencyKey);
        break;
      }
      case 'get':
        output = await options.sdk.get(ownerId, operations.get.input.parse(data).id);
        break;
      case 'list':
        output = { items: await options.sdk.list(ownerId, operations.list.input.parse(data)) };
        break;
      case 'retry':
        output = await options.sdk.retry(ownerId, operations.retry.input.parse(data).id);
        break;
      case 'info':
        output = { version: RELEASE_VERSION, contractHash };
        break;
      case 'upload': {
        const value = operations.upload.input.parse(data);
        output = await options.files.upload(ownerId, value.fileName, value.data);
        break;
      }
      case 'resolve': {
        const context: AdapterContext = {
          ownerId,
          jobId: randomUUID(),
          attempt: 0,
          signal: AbortSignal.timeout(120000),
        };
        output = await options.sources.resolve(
          operations.resolve.input.parse(data).source,
          context,
        );
        break;
      }
      case 'download': {
        const context: AdapterContext = {
          ownerId,
          jobId: randomUUID(),
          attempt: 0,
          signal: AbortSignal.timeout(120000),
        };
        try {
          const source: Source = operations.download.input.parse(data).source;
          const resolved = await options.sources.resolve(source, context);
          const artifact = await options.sources.materialize(resolved, context);
          if ((await stat(artifact.uri)).size > 32 * 1024 * 1024)
            throw new MediaError(
              'payload_too_large',
              'Downloads through the API are limited to 32 MiB',
            );
          output = {
            fileName: artifact.fileName,
            data: (await readFile(artifact.uri)).toString('base64'),
            mimeType: artifact.mimeType,
          };
        } finally {
          await options.media.cleanup(context);
        }
        break;
      }
    }
    const validated = operation.output.safeParse(output);
    if (!validated.success) throw new Error('Operation produced an invalid response');
    return validated.data;
  };

  const mcp = createMcpHandler(
    ({ authInfo }) => {
      const server = new McpServer({ name: 'media-ingest', version: RELEASE_VERSION });
      for (const id of operationIds) {
        const operation = operations[id];
        if (!authInfo || (operation.scope !== null && !authInfo.scopes.includes(operation.scope)))
          continue;
        server.registerTool(
          `media_${id}`,
          {
            description: operation.description,
            inputSchema: operation.input as z.ZodType,
            outputSchema: operation.output as z.ZodType,
            annotations: {
              readOnlyHint: operation.scope !== 'media:write',
              destructiveHint: false,
              openWorldHint: id === 'submit' || id === 'resolve' || id === 'download',
              idempotentHint: operation.scope !== 'media:write',
            },
          },
          async (input) => {
            try {
              const value = await dispatch('owner', authInfo.scopes, id, input);
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(value) }],
                structuredContent: value as Record<string, unknown>,
              };
            } catch (error) {
              report(error);
              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text:
                      error instanceof MediaError
                        ? error.message
                        : 'Request failed validation or processing',
                  },
                ],
              };
            }
          },
        );
      }
      return server;
    },
    { responseMode: 'json' },
  );

  app.use('*', async (c, next) => {
    // Trust the configured public authority, never arbitrary forwarded host headers.
    if (
      c.req.path !== '/healthz' &&
      c.req.header('host') &&
      c.req.header('host') !== new URL(options.publicUrl).host
    )
      return c.json({ error: { code: 'invalid_host', message: 'Invalid Host' } }, 403);
    c.header('x-content-type-options', 'nosniff');
    c.header('cache-control', 'no-store');
    await next();
  });
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.use('*', async (c, next) => {
    const response = await auth.handle(c.req.raw);
    if (response) return response;
    await next();
  });
  app.use('*', async (c, next) => {
    const requestOrigin = c.req.header('origin');
    if (
      requestOrigin &&
      requestOrigin !== origin &&
      !options.allowedOrigins?.includes(requestOrigin)
    )
      return c.json({ error: { code: 'invalid_origin', message: 'Invalid Origin' } }, 403);
    await next();
  });
  app.use('*', async (c, next) => {
    const resource = c.req.path === '/mcp' ? `${origin}/mcp` : origin;
    const identity = await auth.authenticate(c.req.raw, resource);
    if (!identity) return auth.challenge(resource);
    c.set('identity', identity);
    await next();
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 46 * 1024 * 1024,
      onError: (c) =>
        c.json({ error: { code: 'payload_too_large', message: 'Request is too large' } }, 413),
    }),
  );
  app.all('/mcp', async (c) => {
    const identity = c.get('identity');
    return mcp.fetch(c.req.raw, {
      authInfo: { token: 'verified', clientId: 'media-client', scopes: identity.scopes },
    });
  });
  app.get('/openapi.json', async (c) => {
    return c.json(openApiDocument());
  });
  for (const id of operationIds) {
    const operation = operations[id];
    app.on(operation.method, operation.path, async (c) => {
      const identity = c.get('identity');
      const suppliedHash = c.req.header('x-media-contract');
      if (operation.method !== 'GET' && suppliedHash && suppliedHash !== contractHash)
        return c.json(
          { error: { code: 'contract_mismatch', message: 'Client and server contracts differ' } },
          409,
        );
      let data: Record<string, unknown>;
      if (operation.method === 'GET') data = { ...c.req.query(), ...c.req.param() };
      else {
        if (!c.req.header('content-type')?.startsWith('application/json'))
          return c.json(
            { error: { code: 'invalid_content_type', message: 'Expected application/json' } },
            415,
          );
        try {
          data = await c.req.json();
        } catch {
          return c.json({ error: { code: 'invalid_json', message: 'Invalid JSON' } }, 400);
        }
        if (!data || typeof data !== 'object' || Array.isArray(data))
          return c.json({ error: { code: 'invalid_input', message: 'Expected object' } }, 400);
        for (const [key, value] of Object.entries(c.req.param())) {
          if (data[key] !== undefined && data[key] !== value)
            return c.json(
              { error: { code: 'invalid_input', message: 'Path and body disagree' } },
              400,
            );
          data[key] = value;
        }
      }
      const output = await dispatch(identity.ownerId, identity.scopes, id, data);
      c.header('x-media-contract', contractHash);
      return c.json(output as Record<string, unknown>);
    });
  }
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: {
            code: 'invalid_input',
            message: 'Input did not match the operation schema',
            issues: error.issues.map(({ path, message }) => ({ path, message })),
          },
        },
        400,
      );
    if (error instanceof MediaError) {
      const status =
        error.code === 'not_found'
          ? 404
          : error.code === 'forbidden'
            ? 403
            : error.code === 'payload_too_large'
              ? 413
              : error.code.includes('conflict') || error.code === 'invalid_state'
                ? 409
                : 400;
      return c.json({ error: { code: error.code, message: error.message } }, status);
    }
    report(error);
    return c.json({ error: { code: 'internal_error', message: 'Unexpected server error' } }, 500);
  });
  return { app, dispatch, close: () => mcp.close() };
}
