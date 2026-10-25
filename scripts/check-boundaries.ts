import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import {
  RELEASE_VERSION,
  operationIds,
  operations,
  openApiDocument,
} from '../packages/contracts/src/index.js';

const root = resolve(import.meta.dirname, '..');
const allowed: Record<string, string[]> = {
  contracts: [],
  sdk: ['contracts'],
  adapters: ['contracts', 'sdk'],
  client: ['contracts'],
  cli: ['contracts', 'client'],
};
async function files(path: string): Promise<string[]> {
  return (
    await Promise.all(
      (await readdir(path, { withFileTypes: true })).map((entry) =>
        entry.isDirectory()
          ? files(resolve(path, entry.name))
          : Promise.resolve([resolve(path, entry.name)]),
      ),
    )
  ).flat();
}
const failures: string[] = [];
const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (rootPackage.version !== RELEASE_VERSION)
  failures.push('Root and contract release versions differ');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${RELEASE_VERSION}`)
  failures.push('Release tag does not match package/API version');
for (const [name, dependencies] of Object.entries(allowed)) {
  const directory = resolve(root, 'packages', name);
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  if (manifest.version !== RELEASE_VERSION) failures.push(`${name}: release version differs`);
  for (const imported of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (
      imported.startsWith('@media-ingest/') &&
      !dependencies.includes(imported.slice('@media-ingest/'.length))
    )
      failures.push(`${name}: forbidden dependency ${imported}`);
  }
  for (const path of await files(resolve(directory, 'src'))) {
    if (!path.endsWith('.ts')) continue;
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(
      /(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g,
    )) {
      const specifier = match[1]!;
      if (
        specifier.startsWith('@media-ingest/') &&
        !dependencies.includes(specifier.slice('@media-ingest/'.length))
      )
        failures.push(`${relative(root, path)}: forbidden import ${specifier}`);
      if (specifier.startsWith('.') && !resolve(path, '..', specifier).startsWith(directory + '/'))
        failures.push(`${relative(root, path)}: import escapes package`);
      if (
        name === 'sdk' &&
        /^(?:node:)?(?:fs|http|https|net|child_process)(?:\/|$)/.test(specifier)
      )
        failures.push(`${relative(root, path)}: SDK imports infrastructure`);
    }
  }
}
const api = JSON.parse(await readFile(resolve(root, 'apps/api/package.json'), 'utf8'));
if (api.version !== RELEASE_VERSION) failures.push('API release version differs');
const routes = new Set<string>();
for (const id of operationIds) {
  const route = `${operations[id].method} ${operations[id].path}`;
  if (routes.has(route)) failures.push(`Duplicate route ${route}`);
  routes.add(route);
}
const apiIds = Object.values(openApiDocument().paths)
  .flatMap((path) =>
    Object.values(path as Record<string, { operationId: string }>).map((op) => op.operationId),
  )
  .sort();
if (JSON.stringify(apiIds) !== JSON.stringify([...operationIds].sort()))
  failures.push('OpenAPI operation coverage differs');
if (failures.length) throw new Error(failures.join('\n'));
console.log(`Boundaries, ${operationIds.length} operations and release ${RELEASE_VERSION} aligned`);
