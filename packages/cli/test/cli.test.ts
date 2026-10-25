import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  contractDocument,
  operationIds,
  operations,
  RELEASE_VERSION,
} from '@media-ingest/contracts';
import { createProgram } from '../src/cli.js';
import { complete, completionScript } from '../src/completion.js';
import { configPath, loadConfig, saveConfig } from '../src/config.js';

afterEach(() => vi.unstubAllGlobals());
const contractHash = createHash('sha256').update(JSON.stringify(contractDocument())).digest('hex');
async function runner(stdin = '') {
  const home = await mkdtemp(join(tmpdir(), 'media-cli-'));
  const output: string[] = [];
  const env = {
    HOME: home,
    MEDIA_API_URL: 'https://media.example.com',
    MEDIA_API_TOKEN: 'not-printed',
  };
  const program = createProgram({
    out: (value) => output.push(value),
    stdin: async () => stdin,
    env,
  }).exitOverride();
  return {
    run: (args: string[]) => program.parseAsync(['node', 'media', ...args]),
    output,
    env,
    home,
    program,
  };
}
describe('CLI contract', () => {
  it('prints usable help and rejects unknown commands', async () => {
    const cli = await runner();
    await expect(cli.run(['--help'])).rejects.toMatchObject({ code: 'commander.helpDisplayed' });
    expect(cli.output.join('\n')).toContain('transcribe');
    const invalid = await runner();
    await expect(invalid.run(['unknown-command'])).rejects.toMatchObject({
      code: 'commander.unknownCommand',
    });
    expect(invalid.output.join('\n')).toContain('unknown command');
  });
  it('exposes every operation with catalog descriptions and offline schema', async () => {
    const cli = await runner();
    for (const id of operationIds)
      expect(cli.program.commands.find((command) => command.name() === id)?.description()).toBe(
        operations[id].description,
      );
    await cli.run(['schema']);
    expect(JSON.parse(cli.output[0]!).map((item: { name: string }) => item.name)).toEqual(
      operationIds,
    );
  });
  it('reads JSON files and positional IDs through HTTP', async () => {
    const cli = await runner();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [] }));
    vi.stubGlobal('fetch', fetcher);
    const file = join(cli.home, 'request.json');
    await writeFile(file, '{"limit":3}');
    await cli.run(['list', '--file', file]);
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://media.example.com/v1/jobs?limit=3');
    expect(cli.output.join('')).not.toContain('not-printed');
  });
  it('uploads local bytes then submits the returned upload source', async () => {
    const cli = await runner();
    const file = join(cli.home, 'audio.mp3');
    await writeFile(file, 'media-bytes');
    const source = { kind: 'upload', uri: '64e2f3cb-50ae-4ee4-9d7b-65150ba23488' };
    const responses = [
      Response.json({ version: RELEASE_VERSION, contractHash }),
      Response.json({ source, size: 11 }),
      Response.json({ version: RELEASE_VERSION, contractHash }),
      Response.json({
        id: source.uri,
        request: { kind: 'transcription', source, provider: 'openai' },
        status: 'queued',
        createdAt: '2026-10-24T00:00:00.000Z',
        updatedAt: '2026-10-24T00:00:00.000Z',
        completedChunks: 0,
        totalChunks: 0,
        attempt: 0,
        result: null,
        error: null,
      }),
    ];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!);
    vi.stubGlobal('fetch', fetcher);
    await cli.run(['transcribe', file]);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({
      fileName: 'audio.mp3',
      data: Buffer.from('media-bytes').toString('base64'),
    });
    expect(JSON.parse(String(fetcher.mock.calls[3]![1]?.body)).request.source).toEqual(source);
  });
  it('supports stdin JSON and rejects conflicting input mechanisms', async () => {
    const cli = await runner('{"limit":2}');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ items: [] })));
    await cli.run(['list', '--file', '-']);
    await expect(
      (await runner()).run(['list', '--input', '{}', '--file', 'ignored']),
    ).rejects.toThrow('either');
    await expect((await runner()).run(['list', '--input', 'bad'])).rejects.toThrow('valid JSON');
    await expect((await runner()).run(['list', '--input', '[]'])).rejects.toThrow('JSON object');
  });
  it('setup stores a private config and never prints its token', async () => {
    const cli = await runner('my-token\n');
    await cli.run(['setup', '--url', 'https://media.example.com', '--token-stdin']);
    expect(cli.output.join('')).not.toContain('my-token');
    expect((await stat(configPath(cli.env))).mode & 0o777).toBe(0o600);
    expect(await loadConfig({ HOME: cli.home })).toEqual({
      baseUrl: 'https://media.example.com',
      token: 'my-token',
    });
    expect(await loadConfig(cli.env)).toMatchObject({ token: 'not-printed' });
  });
  it('fails clearly for missing or corrupted configuration', async () => {
    const cli = await runner();
    await expect(loadConfig({ HOME: cli.home })).rejects.toThrow('MEDIA_API_URL');
    await saveConfig({ baseUrl: 'https://media.example.com', token: 'token' }, { HOME: cli.home });
    await writeFile(configPath({ HOME: cli.home }), 'bad');
    await expect(loadConfig({ HOME: cli.home })).rejects.toThrow('Cannot read');
    await expect(
      saveConfig({ baseUrl: 'https://media.example.com', token: '' }, { HOME: cli.home }),
    ).rejects.toThrow('Token');
  });
  it('completes catalog commands and prints all supported shell scripts', async () => {
    expect(complete([''])).toEqual(expect.arrayContaining(operationIds));
    expect(complete(['su'])).toEqual(['submit']);
    expect(complete(['completion', ''])).toEqual(['bash', 'fish', 'zsh']);
    expect(complete(['skill', 'i'])).toEqual(['install']);
    expect(complete(['schema', 'g'])).toEqual(['get']);
    expect(complete(['get', '--'])).toContain('--help');
    for (const shell of ['bash', 'zsh', 'fish']) expect(completionScript(shell)).toContain('media');
    expect(() => completionScript('other')).toThrow('Supported');
    const cli = await runner();
    await cli.run(['__complete', '--', 'su']);
    expect(cli.output[0]).toBe('submit');
  });
  it('runs offline completion and explicit skill installation commands', async () => {
    const cli = await runner();
    await cli.run(['completion', 'bash']);
    expect(cli.output[0]).toContain('complete -F');
    const installer = await runner();
    await installer.run(['skill', 'install']);
    const result = JSON.parse(installer.output[0]!);
    expect(result.changed).toBe(true);
    expect(await readFile(join(result.destination, 'SKILL.md'), 'utf8')).toContain(
      'name: media-cli',
    );
  });
  it('rejects invalid offline schemas, conflicting IDs, and invalid upload paths', async () => {
    await expect((await runner()).run(['schema', 'nonexistent'])).rejects.toThrow('Unknown');
    await expect((await runner()).run(['get', 'one', '--input', '{"id":"two"}'])).rejects.toThrow(
      'conflicts',
    );
    const cli = await runner();
    await expect(cli.run(['upload', cli.home])).rejects.toThrow('regular file');
    await expect((await runner()).run(['upload', '/unused', '--input', '{}'])).rejects.toThrow(
      'not both',
    );
  });
  it('bundled skill JSON examples validate against the authoritative catalog', async () => {
    const skill = await readFile(
      new URL('../.agents/skills/media-cli/SKILL.md', import.meta.url),
      'utf8',
    );
    const samples = [...skill.matchAll(/media (\w+) --input '([^']+)'/gu)];
    expect(samples.length).toBeGreaterThanOrEqual(3);
    for (const [, id, text] of samples)
      expect(
        operations[id as keyof typeof operations].input.safeParse(JSON.parse(text!)).success,
      ).toBe(true);
  });
});
