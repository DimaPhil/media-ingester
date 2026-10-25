import { installSkill } from './install-skill.mjs';

const explicit = process.argv.includes('--explicit');
if (explicit || process.env.MEDIA_SKIP_SKILL_INSTALL !== '1') {
  try {
    const result = await installSkill();
    if (explicit) process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(
      `media skill installation: ${error.message}. Run media skill install after resolving the conflict.\n`,
    );
    if (explicit) process.exitCode = 1;
  }
}
