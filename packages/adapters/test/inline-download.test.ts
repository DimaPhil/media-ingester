import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { NodeFiles } from '../src/files.js';

it('reads exactly the allowed bytes and rejects a file one byte over the limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-download-'));
  try {
    const files = new NodeFiles({ workRoot: root });
    const path = join(root, 'fixture');
    await writeFile(path, '1234');
    const artifact = await files.artifact(path, 'fixture');
    const signal = new AbortController().signal;
    await expect(files.readArtifact(artifact, 4, signal)).resolves.toEqual(Buffer.from('1234'));
    await expect(files.readArtifact(artifact, 3, signal)).rejects.toMatchObject({
      code: 'payload_too_large',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
