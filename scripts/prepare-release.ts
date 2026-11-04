import { createHash } from 'node:crypto';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  RELEASE_VERSION,
  contractDocument,
  openApiDocument,
} from '../packages/contracts/src/index.js';

const execFile = promisify(callback);
const root = resolve(import.meta.dirname, '..');
const destination = resolve(root, 'release', RELEASE_VERSION);
await mkdir(destination, { recursive: true });
for (const name of ['contracts', 'sdk', 'adapters', 'client', 'cli']) {
  await execFile('pnpm', ['pack', '--pack-destination', destination], {
    cwd: resolve(root, 'packages', name),
    env: { ...process.env, MEDIA_SKIP_SKILL_INSTALL: '1' },
  });
}
const revision = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
const dirty = Boolean(
  (await execFile('git', ['status', '--porcelain'], { cwd: root })).stdout.trim(),
);
const artifacts = await Promise.all(
  (await readdir(destination))
    .filter((name) => name.endsWith('.tgz'))
    .sort()
    .map(async (name) => ({
      name,
      sha256: createHash('sha256')
        .update(await readFile(resolve(destination, name)))
        .digest('hex'),
    })),
);
const manifest = {
  version: RELEASE_VERSION,
  revision,
  dirty,
  contractHash: createHash('sha256').update(JSON.stringify(contractDocument())).digest('hex'),
  apiImage: `media-ingest:${RELEASE_VERSION}`,
  artifacts,
};
await writeFile(resolve(destination, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(
  resolve(destination, 'openapi.json'),
  JSON.stringify(openApiDocument(), null, 2) + '\n',
);
console.log(
  `Release artifacts prepared at ${destination}; publish API image and CLI assets from this same revision.`,
);
