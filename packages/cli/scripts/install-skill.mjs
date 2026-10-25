import { createHash, randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const markerName = '.media-cli-managed.json';
const linkTarget = '../../.agents/skills/media-cli';
export const bundledSkillPath = fileURLToPath(
  new URL('../.agents/skills/media-cli', import.meta.url),
);
async function entry(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
async function snapshot(path) {
  const entries = [];
  async function visit(relative) {
    for (const item of (await readdir(join(path, relative), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!relative && item.name === markerName) continue;
      const name = join(relative, item.name);
      if (item.isDirectory()) {
        entries.push(`dir:${name}`);
        await visit(name);
      } else if (item.isFile())
        entries.push(
          `file:${name}:${createHash('sha256')
            .update(await readFile(join(path, name)))
            .digest('hex')}`,
        );
      else throw new Error(`Skill contains unsupported filesystem entries: ${name}`);
    }
  }
  await visit('');
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}
export async function installSkill({
  home = process.env.HOME ?? homedir(),
  source = bundledSkillPath,
} = {}) {
  const destination = join(home, '.agents', 'skills', 'media-cli');
  const claudeLink = join(home, '.claude', 'skills', 'media-cli');
  const previous = await entry(destination);
  if (previous) {
    if (!previous.isDirectory() || previous.isSymbolicLink())
      throw new Error(
        'Existing media-cli skill is not a managed directory; move it before installing',
      );
    let marker;
    try {
      marker = JSON.parse(await readFile(join(destination, markerName), 'utf8'));
    } catch {
      throw new Error('Refusing to overwrite an unmanaged media-cli skill');
    }
    if (marker.package !== '@media-ingest/cli' || marker.hash !== (await snapshot(destination)))
      throw new Error(
        'Refusing to overwrite a locally modified media-cli skill; move it before reinstalling',
      );
  }
  const link = await entry(claudeLink);
  if (link && (!link.isSymbolicLink() || (await readlink(claudeLink)) !== linkTarget))
    throw new Error('Refusing to overwrite an unmanaged Claude media-cli skill path');
  const hash = await snapshot(source);
  const changed = !previous || (await snapshot(destination)) !== hash;
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(dirname(claudeLink), { recursive: true });
  if (changed) {
    const staged = `${destination}.${randomUUID()}.tmp`;
    const backup = `${destination}.${randomUUID()}.backup`;
    await cp(source, staged, { recursive: true, force: false, errorOnExist: true });
    await writeFile(
      join(staged, markerName),
      JSON.stringify({ package: '@media-ingest/cli', hash }) + '\n',
    );
    try {
      if (previous) await rename(destination, backup);
      try {
        await rename(staged, destination);
      } catch (error) {
        if (previous) await rename(backup, destination);
        throw error;
      }
      if (previous) await rm(backup, { recursive: true });
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  }
  if (!link) await symlink(linkTarget, claudeLink, 'dir');
  return { destination, claudeLink, changed: changed || !link };
}
