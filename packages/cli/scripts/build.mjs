import { rm, mkdir, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = new URL('../dist/', import.meta.url);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  banner: {
    js: "import { createRequire as mediaCreateRequire } from 'node:module'; const require = mediaCreateRequire(import.meta.url);",
  },
  target: 'node22',
  sourcemap: true,
});
await chmod(new URL('index.js', dist), 0o755);
