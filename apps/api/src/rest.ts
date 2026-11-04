import { Hono } from 'hono';
import { openApiDocument, operationIds, operations } from '@media-ingest/contracts';
import type { Identity } from './auth/index.js';
import { contractHash, type OperationDispatcher } from './operations.js';

export function createRestRoutes(dispatch: OperationDispatcher) {
  const app = new Hono<{ Variables: { identity: Identity } }>();
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
  return app;
}
