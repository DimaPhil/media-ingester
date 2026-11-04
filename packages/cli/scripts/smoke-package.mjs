import { mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'media-cli-smoke-'));
try {
  await exec('pnpm', ['pack', '--pack-destination', temporary], { cwd: packageRoot });
  const prefix = join(temporary, 'prefix');
  const home = join(temporary, 'home');
  const env = {
    ...process.env,
    HOME: home,
    NPM_CONFIG_CACHE: join(temporary, 'cache'),
    MEDIA_SKIP_SKILL_INSTALL: '0',
  };
  await exec(
    'npm',
    [
      'install',
      '--global',
      join(temporary, `media-ingest-cli-${version}.tgz`),
      '--prefix',
      prefix,
      '--no-audit',
      '--no-fund',
      '--offline',
    ],
    { env },
  );
  const binary = join(prefix, 'bin', 'media');
  const { stdout } = await exec(binary, ['--help'], { env });
  if (!stdout.includes('transcribe')) throw new Error('Missing CLI help');
  const installed = JSON.parse(
    await readFile(join(prefix, 'lib/node_modules/@media-ingest/cli/package.json'), 'utf8'),
  );
  if (installed.dependencies && Object.keys(installed.dependencies).length)
    throw new Error('Runtime dependencies remain');
  const skill = await readFile(join(home, '.agents/skills/media-cli/SKILL.md'), 'utf8');
  if (!skill.includes('name: media-cli')) throw new Error('Skill missing');
  if ((await readlink(join(home, '.claude/skills/media-cli'))) !== '../../.agents/skills/media-cli')
    throw new Error('Adapter missing');
  const { stdout: schema } = await exec(binary, ['schema', 'submit'], { env });
  if (JSON.parse(schema)[0].name !== 'submit') throw new Error('Schema failed');
  console.log(
    'PASS: offline global tarball installation; CLI help/schema; zero runtime dependencies; postinstall skill and relative Claude adapter.',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
