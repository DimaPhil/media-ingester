import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { MediaError } from '@media-ingest/sdk';
import { createAuth, type AuthStore, type Identity } from './auth/index.js';
import { contractHash, createDispatcher, type OperationDependencies } from './operations.js';
import { createMediaMcpHandler } from './mcp.js';
import { createRestRoutes } from './rest.js';

export { contractHash };
export interface ApplicationOptions extends OperationDependencies {
  authStore: AuthStore;
  publicUrl: string;
  ownerToken: string;
  allowedOrigins?: string[];
  logger?: (error: unknown) => void;
}

function mediaErrorStatus(code: string) {
  if (code === 'not_found') return 404;
  if (code === 'forbidden') return 403;
  if (code === 'payload_too_large') return 413;
  if (code === 'invalid_state' || code.includes('conflict')) return 409;
  return 400;
}

export function createApplication(options: ApplicationOptions) {
  const { origin, host } = new URL(options.publicUrl);
  const auth = createAuth({
    publicUrl: options.publicUrl,
    ownerToken: options.ownerToken,
    store: options.authStore,
  });
  const app = new Hono<{ Variables: { identity: Identity } }>();
  const report = options.logger ?? (() => {});
  const dispatch = createDispatcher(options);
  const mcp = createMediaMcpHandler(dispatch, report);

  app.use('*', async (c, next) => {
    // Trust the configured public authority, never arbitrary forwarded host headers.
    const requestHost = c.req.header('host');
    if (c.req.path !== '/healthz' && requestHost && requestHost !== host)
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
  app.route('/', createRestRoutes(dispatch));
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
    if (error instanceof MediaError)
      return c.json(
        { error: { code: error.code, message: error.message } },
        mediaErrorStatus(error.code),
      );
    report(error);
    return c.json({ error: { code: 'internal_error', message: 'Unexpected server error' } }, 500);
  });
  return { app, dispatch, close: () => mcp.close() };
}
