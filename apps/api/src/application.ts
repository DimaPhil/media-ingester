import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  operationIds,
  operations,
  openApiDocument,
  RELEASE_VERSION,
} from '@media-ingest/contracts';
import { MediaError } from '@media-ingest/sdk';
import { createAuth, type AuthStore, type Identity } from './auth/index.js';
import { contractHash, createDispatcher, type OperationDependencies } from './operations.js';

export { contractHash };
export interface ApplicationOptions extends OperationDependencies {
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
  const dispatch = createDispatcher(options);

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
