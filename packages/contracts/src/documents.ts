import { z } from 'zod';
import { operationIds, operations, RELEASE_VERSION } from './operations.js';

export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
}
export function contractDocument() {
  return operationIds.map((id) => ({
    id,
    ...operations[id],
    input: jsonSchema(operations[id].input),
    output: jsonSchema(operations[id].output),
  }));
}
export function openApiDocument() {
  const paths: Record<string, unknown> = {};
  for (const id of operationIds) {
    const op = operations[id];
    const path = op.path.replace(/:([a-zA-Z]+)/g, '{$1}');
    const input = jsonSchema(op.input);
    const properties = (input.properties ?? {}) as Record<string, unknown>;
    const required = (input.required ?? []) as string[];
    const parameters = Object.entries(properties)
      .filter(([name]) => op.method === 'GET' || op.path.includes(':' + name))
      .map(([name, schema]) => ({
        name,
        in: op.path.includes(':' + name) ? 'path' : 'query',
        required: op.path.includes(':' + name) || required.includes(name),
        schema,
      }));
    paths[path] = {
      ...(paths[path] as object),
      [op.method.toLowerCase()]: {
        operationId: id,
        description: op.description,
        security: [{ bearer: [] }],
        parameters,
        ...(op.method === 'POST'
          ? { requestBody: { required: true, content: { 'application/json': { schema: input } } } }
          : {}),
        responses: {
          '200': {
            description: 'Success',
            content: { 'application/json': { schema: jsonSchema(op.output) } },
          },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Media Ingest API', version: RELEASE_VERSION },
    paths,
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
  };
}
