import { mkdtemp, readFile, readlink, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installSkill } from '../scripts/install-skill.mjs';

describe('bundled skill installer', () => {
  it('installs canonical content and relative Claude adapter; repeated install is idempotent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'media-skill-'));
    const first = await installSkill({ home });
    expect(first.changed).toBe(true);
    expect(await readFile(join(first.destination, 'SKILL.md'), 'utf8')).toContain(
      'name: media-cli',
    );
    expect(await readlink(first.claudeLink)).toBe('../../.agents/skills/media-cli');
    expect((await installSkill({ home })).changed).toBe(false);
    await rm(first.claudeLink);
    expect((await installSkill({ home })).changed).toBe(true);
  });
  it('preserves local edits and unmanaged directories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'media-skill-'));
    const result = await installSkill({ home });
    await writeFile(join(result.destination, 'SKILL.md'), 'my changes');
    await expect(installSkill({ home })).rejects.toThrow('locally modified');
    expect(await readFile(join(result.destination, 'SKILL.md'), 'utf8')).toBe('my changes');
    await rm(join(result.destination, '.media-cli-managed.json'));
    await expect(installSkill({ home })).rejects.toThrow('unmanaged');
  });
  it('refuses skill directory symlinks and conflicting Claude links', async () => {
    const home = await mkdtemp(join(tmpdir(), 'media-skill-'));
    await mkdir(join(home, '.agents', 'skills'), { recursive: true });
    await symlink('/tmp', join(home, '.agents', 'skills', 'media-cli'));
    await expect(installSkill({ home })).rejects.toThrow('managed directory');
    await rm(join(home, '.agents', 'skills', 'media-cli'));
    await mkdir(join(home, '.claude', 'skills', 'media-cli'), { recursive: true });
    await expect(installSkill({ home })).rejects.toThrow('Claude');
  });
  it('upgrades unmodified managed content and retains a valid marker', async () => {
    const home = await mkdtemp(join(tmpdir(), 'media-skill-'));
    const source = await mkdtemp(join(tmpdir(), 'media-skill-source-'));
    await writeFile(join(source, 'SKILL.md'), 'v1');
    const result = await installSkill({ home, source });
    await writeFile(join(source, 'SKILL.md'), 'v2');
    expect((await installSkill({ home, source })).changed).toBe(true);
    expect(await readFile(join(result.destination, 'SKILL.md'), 'utf8')).toBe('v2');
    expect((await installSkill({ home, source })).changed).toBe(false);
  });
});
