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
import { createProgram, inferSource, runCli } from '../src/cli.js';
import { commandExamples, renderStep } from '../src/output.js';
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
  it.each([
    ['https://t.me/channel/17', 'telegram'],
    ['https://telegram.me/c/123/4/17', 'telegram'],
    ['tg://chat/-100123/17', 'telegram'],
    ['https://t.me/+invite', 'telegram'],
    ['https://m.youtube.com/watch?v=a', 'youtube'],
    ['https://youtu.be/a', 'youtube'],
    ['https://www.instagram.com/reel/a/', 'instagram'],
    ['https://mobile.twitter.com/a/status/12', 'x'],
    ['https://x.com/a/status/12', 'x'],
    ['https://drive.google.com/file/d/a/view', 'google_drive'],
    ['https://docs.google.com/document/d/a/edit', 'google_drive'],
    ['https://t.me.example.com/a/17', 'http'],
    ['https://t.me@elsewhere.example/a/17', 'http'],
    ['./t.me/channel/17', 'local_file'],
  ])('infers the adapter for %s', (uri, kind) => {
    expect(inferSource(uri)).toEqual({ kind, uri });
  });
  it('honors an explicit source kind', () => {
    const uri = 'https://www.instagram.com/reel/a/';
    expect(inferSource(uri, 'yt_dlp')).toEqual({ kind: 'yt_dlp', uri });
  });
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
    expect(configPath({ ...cli.env, XDG_CONFIG_HOME: '/unused' })).toBe(
      join(cli.home, '.lilfeel', 'media', 'config.json'),
    );
    await cli.run(['setup', '--url', 'https://media.example.com', '--token-stdin']);
    expect(cli.output.join('')).not.toContain('my-token');
    expect((await stat(configPath(cli.env))).mode & 0o777).toBe(0o600);
    expect(await loadConfig({ HOME: cli.home })).toEqual({
      baseUrl: 'https://media.example.com',
      token: 'my-token',
    });
    expect(await loadConfig(cli.env)).toMatchObject({ token: 'not-printed' });
  });
  it('uses the saved token only for its normalized base URL', async () => {
    const cli = await runner();
    const env = { HOME: cli.home, MEDIA_API_URL: 'https://media.example.com/team' };
    await saveConfig({ baseUrl: env.MEDIA_API_URL, token: 'saved' }, env);
    expect(
      await loadConfig({ ...env, MEDIA_API_URL: 'https://MEDIA.example.com:443/team/' }),
    ).toEqual({
      baseUrl: env.MEDIA_API_URL,
      token: 'saved',
    });
    for (const url of ['https://other.example.com/team', 'https://media.example.com/other']) {
      const override = { ...env, MEDIA_API_URL: url };
      await expect(loadConfig(override)).rejects.toThrow('MEDIA_API_TOKEN');
      expect(await loadConfig({ ...override, MEDIA_API_TOKEN: 'explicit' })).toEqual({
        baseUrl: url,
        token: 'explicit',
      });
    }
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

describe('agent-facing CLI output', () => {
  const id = '00000000-0000-4000-8000-000000000000';
  async function exec(args: string[], env: Record<string, string> = {}) {
    const home = await mkdtemp(join(tmpdir(), 'media-cli-'));
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['node', 'media', ...args], {
      out: (value) => out.push(value),
      err: (value) => err.push(value),
      stdin: async () => '',
      env: {
        HOME: home,
        MEDIA_API_URL: 'https://media.example.com',
        MEDIA_API_TOKEN: 'not-printed',
        ...env,
      },
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  const job = {
    id,
    request: {
      kind: 'transcription',
      source: { kind: 'http', uri: 'https://example.com/a.mp3' },
      provider: 'google-gemini',
      model: 'gemini-2.5-flash',
    },
    createdAt: '2026-10-24T00:00:00.000Z',
    updatedAt: '2026-10-24T00:00:00.000Z',
    attempt: 1,
    result: null,
  };

  it('reports usage errors as JSON with valid options and exit code 2', async () => {
    const unknown = await exec(['get', '--fo']);
    expect(unknown.code).toBe(2);
    expect(JSON.parse(unknown.out)).toEqual({
      error: { code: 'usage_error', message: "unknown option '--fo'", details: { command: 'get' } },
      help: ['media get --help', 'Valid options: --input <json>, --file <path>, -h, --help'],
    });
    const missing = await exec(['transcribe']);
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.out).error.message).toContain("missing required argument 'source'");
    const command = await exec(['bogus']);
    expect(command.code).toBe(2);
    expect(JSON.parse(command.out).help[1]).toContain('transcribe');
    const invalid = await exec(['transcribe', 'https://x.test/a', '--provider', 'bogus']);
    expect(invalid.code).toBe(2);
    expect(JSON.parse(invalid.out).error.code).toBe('invalid_input');
    const local = await exec(['list', '--input', '[]']);
    expect(local).toMatchObject({ code: 2 });
    expect(JSON.parse(local.out).error).toEqual({
      code: 'usage_error',
      message: 'Input must be a JSON object',
    });
    expect(await exec(['--help'])).toMatchObject({ code: 0 });
    expect(await exec(['--version'])).toMatchObject({ code: 0, out: RELEASE_VERSION });
  });

  it('reports API failures with the server code, HTTP status and a hint, exit code 1', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json(
            { error: { code: 'not_found', message: 'Job not found <script>' } },
            { status: 404 },
          ),
        )
        .mockResolvedValueOnce(Response.json({ error: { code: 'BAD CODE' } }, { status: 401 })),
    );
    const missing = await exec(['get', id]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.out)).toEqual({
      error: { code: 'not_found', message: 'Resource not found.', details: { httpStatus: 404 } },
      help: ['media list  # find the job ID'],
    });
    const denied = await exec(['list']);
    expect(denied.code).toBe(1);
    expect(JSON.parse(denied.out)).toMatchObject({
      error: { code: 'http_error', details: { httpStatus: 401 } },
      help: [expect.stringContaining('media setup')],
    });
    expect(missing.out + denied.out).not.toContain('not-printed');
  });

  it('adds help commands rendered from next steps to job views', async () => {
    const failed = {
      ...job,
      status: 'failed',
      stage: 'failed',
      completedChunks: 4,
      totalChunks: 18,
      error: {
        code: 'provider_invalid_output',
        message: 'google-gemini returned unusable output: response is not valid JSON',
        retryable: true,
        details: { provider: 'google-gemini', chunkIndex: 4, parseErrorPosition: 11848 },
        nextSteps: [
          { operation: 'retry', input: { id }, reason: 'retry reuses 4 completed chunks' },
          {
            operation: 'submit',
            input: { request: { ...job.request, model: undefined, provider: 'openai' } },
            reason: "Process with openai instead; uses that provider's quota",
          },
        ],
      },
    };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json(failed)));
    const shown = await exec(['get', id]);
    expect(shown.code).toBe(0);
    const value = JSON.parse(shown.out);
    expect(value.error.nextSteps).toHaveLength(2);
    expect(value.help).toEqual([
      `media retry ${id}  # retry reuses 4 completed chunks`,
      // A quote in the trailing comment needs no escaping; the shell ignores comments.
      `media submit --input '{"request":{"kind":"transcription","source":{"kind":"http","uri":"https://example.com/a.mp3"},"provider":"openai"}}'  # Process with openai instead; uses that provider's quota`,
    ]);
    const running = {
      ...job,
      status: 'running',
      stage: 'processing',
      completedChunks: 3,
      totalChunks: 18,
      error: null,
      nextSteps: [
        {
          operation: 'get',
          input: { id },
          reason: 'Job is processing (3/18 chunks done)',
          pollAfterSeconds: 30,
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json(running)));
    expect(JSON.parse((await exec(['get', id])).out).help).toEqual([
      `media get ${id}  # after 30s: Job is processing (3/18 chunks done)`,
    ]);
    const completed = { ...running, status: 'completed', stage: 'completed', nextSteps: undefined };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json(completed)));
    expect(JSON.parse((await exec(['get', id])).out)).not.toHaveProperty('help');
  });

  it('quotes JSON inputs safely for the shell', () => {
    expect(
      renderStep({ operation: 'resolve', input: { source: { uri: "it's" } }, reason: 'check' }),
    ).toBe(`media resolve --input '{"source":{"uri":"it'\\''s"}}'  # check`);
  });

  it('shows examples in per-command help and keeps their JSON valid for the catalog', async () => {
    const help = await exec(['get', '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('Examples:');
    expect(help.out).toContain(`media get ${id}`);
    for (const [name, lines] of Object.entries(commandExamples)) {
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThanOrEqual(3);
      for (const line of lines) {
        const sample = /^media (\w+) --input '([^']+)'$/u.exec(line);
        if (sample)
          expect(
            operations[sample[1] as keyof typeof operations].input.safeParse(JSON.parse(sample[2]!))
              .success,
            `${name}: ${line}`,
          ).toBe(true);
      }
    }
  });
});
