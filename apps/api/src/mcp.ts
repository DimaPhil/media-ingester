import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { operationIds, operations, RELEASE_VERSION } from '@media-ingest/contracts';
import { MediaError } from '@media-ingest/sdk';
import type { OperationDispatcher } from './operations.js';

export function createMediaMcpHandler(
  dispatch: OperationDispatcher,
  report: (error: unknown) => void,
) {
  return createMcpHandler(
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
}
