import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeFiles } from '../src/files.js';
import { NodeSources } from '../src/sources.js';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  safe: vi.fn(),
  token: vi.fn().mockResolvedValue('google-token'),
}));
vi.mock('../src/media.js', () => ({ runCommand: mocks.run }));
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getAccessToken = mocks.token;
  },
}));
vi.mock('../src/safe-fetch.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/safe-fetch.js')>('../src/safe-fetch.js');
  return {
    ...actual,
    safeRequest: mocks.safe,
    publicUrl: async (uri: string) => ({ url: new URL(uri), address: '1.1.1.1', family: 4 }),
  };
});
const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'sources-'));
  roots.push(root);
  return {
    files: new NodeFiles({ workRoot: root }),
    context: { ownerId: 'owner', jobId: 'job', attempt: 1, signal: new AbortController().signal },
  };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  mocks.run.mockReset();
  mocks.safe.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('source adapters', () => {
  it('inspects HTTP metadata and downloads bounded streams', async () => {
    const { files, context } = await setup();
    const stream = Object.assign(Readable.from(['bytes']), {
      headers: { 'content-type': 'audio/mpeg' },
    });
    mocks.safe.mockResolvedValueOnce(stream).mockResolvedValueOnce(Readable.from(['media']));
    const sources = new NodeSources({ files });
    const resolved = await sources.resolve(
      { kind: 'http', uri: 'https://example.com/audio.mp3' },
      context,
    );
    expect(resolved.mimeType).toBe('audio/mpeg');
    expect((await sources.materialize(resolved, context)).fingerprint).toHaveLength(64);
  });
  it('constrains yt-dlp hosts, uses explicit argv and preserves cookie configuration', async () => {
    const { files, context } = await setup();
    const sources = new NodeSources({
      files,
      ytDlpCookiesPath: '/config/cookies.txt',
      ytDlpCookiesFromBrowser: 'firefox',
    });
    await expect(
      sources.resolve({ kind: 'youtube', uri: 'https://evil.example/x' }, context),
    ).rejects.toThrow('not allowed');
    await expect(
      sources.resolve({ kind: 'youtube', uri: 'https://youtube.com/watch?v=x&list=y' }, context),
    ).rejects.toThrow('playlist');
    mocks.run.mockResolvedValueOnce(JSON.stringify({ title: 'Title', ext: 'mp4' }));
    const resolved = await sources.resolve(
      { kind: 'youtube', uri: 'https://youtube.com/watch?v=x' },
      context,
    );
    expect(resolved.fileName).toBe('Title.mp4');
    expect(mocks.run.mock.calls[0]![1]).toEqual(
      expect.arrayContaining([
        '--cookies',
        '/config/cookies.txt',
        '--cookies-from-browser',
        'firefox',
        '--use-extractors',
        '^youtube$',
      ]),
    );
    mocks.run.mockImplementationOnce(async (_binary: string, args: string[]) => {
      const template = args[args.indexOf('-o') + 1]!;
      await writeFile(
        template.replace('%(autonumber)05d', '00001').replace('%(ext)s', 'mp4'),
        'video',
      );
      return '';
    });
    expect((await sources.materialize(resolved, context)).fileName).toBe('Title.mp4');
    mocks.run.mockResolvedValueOnce(JSON.stringify({ _type: 'playlist' }));
    await expect(
      sources.resolve({ kind: 'youtube', uri: 'https://youtu.be/x' }, context),
    ).rejects.toThrow('Playlists');
  });
  it('supports operator-approved yt-dlp hosts and rejects missing downloads', async () => {
    const { files, context } = await setup();
    const sources = new NodeSources({
      files,
      ytDlpSites: [{ id: 'custom', hosts: ['videos.example'], extractors: ['Example'] }],
    });
    mocks.run.mockResolvedValueOnce('{}');
    const resolved = await sources.resolve(
      { kind: 'yt_dlp', uri: 'https://videos.example/a' },
      context,
    );
    expect(mocks.run.mock.calls[0]![1]).toEqual(
      expect.arrayContaining(['--use-extractors', '^Example$']),
    );
    mocks.run.mockResolvedValueOnce('');
    await expect(sources.materialize(resolved, context)).rejects.toThrow('exactly one');
  });
  it('routes named Instagram/X and generic known hosts with provider-scoped cookies', async () => {
    const { files, context } = await setup();
    const sources = new NodeSources({
      files,
      ytDlpCookiesPath: '/youtube.txt',
      ytDlpAuth: {
        instagram: { cookiesPath: '/instagram.txt' },
        x: { cookiesFromBrowser: 'firefox:x-profile' },
      },
    });
    mocks.run.mockResolvedValue('{}');
    const instagram = await sources.resolve(
      { kind: 'instagram', uri: 'https://www.instagram.com/reel/ABC123/' },
      context,
    );
    expect(instagram.metadata.downloadProvider).toBe('instagram');
    expect(mocks.run.mock.calls[0]![1]).toEqual(
      expect.arrayContaining(['^Instagram$', '/instagram.txt']),
    );
    expect(mocks.run.mock.calls[0]![1]).not.toContain('/youtube.txt');
    await sources.resolve({ kind: 'yt_dlp', uri: 'https://x.com/user/status/123' }, context);
    expect(mocks.run.mock.calls[1]![1]).toEqual(
      expect.arrayContaining(['^twitter$', 'firefox:x-profile']),
    );
    await sources.resolve({ kind: 'x', uri: 'https://twitter.com/user/status/123' }, context);
    mocks.run.mockResolvedValueOnce(JSON.stringify({ _type: 'multi_video', entries: [] }));
    await expect(
      sources.resolve({ kind: 'instagram', uri: 'https://instagram.com/p/ABC/' }, context),
    ).rejects.toThrow('multi-item');
    await expect(
      sources.resolve({ kind: 'yt_dlp', uri: 'https://threads.com/@person/post/ABC' }, context),
    ).rejects.toMatchObject({ code: 'unsupported_source' });
  });
  it('resolves and downloads Google Drive files through fixed Google endpoints', async () => {
    const { files, context } = await setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ name: 'drive.mp3', mimeType: 'audio/mpeg' }))
      .mockResolvedValueOnce(new Response('drive bytes'));
    vi.stubGlobal('fetch', fetcher);
    const sources = new NodeSources({ files });
    const resolved = await sources.resolve(
      { kind: 'google_drive', uri: 'https://drive.google.com/file/d/abc/view' },
      context,
    );
    expect(resolved.fileName).toBe('drive.mp3');
    expect((await sources.materialize(resolved, context)).fingerprint).toHaveLength(64);
    expect(fetcher.mock.calls[1]![0]).toContain('/drive/v3/files/abc?alt=media');
    fetcher.mockResolvedValueOnce(Response.json({}));
    await expect(
      sources.resolve(
        { kind: 'google_drive', uri: 'https://drive.google.com/open?id=abc' },
        context,
      ),
    ).rejects.toThrow('name');
  });
  it('resolves single Telegram media, prevents bearer redirects and rejects ambiguity', async () => {
    const { files, context } = await setup();
    const sources = new NodeSources({
      files,
      telegramBaseUrl: 'http://127.0.0.1:8080',
      telegramToken: 'proxy-token',
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { peer: { id: 'chat' } } }))
      .mockResolvedValueOnce(
        Response.json({
          data: [{ media_id: 'm1', file_name: 'clip.mp4', mime_type: 'video/mp4' }],
        }),
      )
      .mockResolvedValueOnce(new Response('telegram bytes'));
    vi.stubGlobal('fetch', fetcher);
    const source = { kind: 'telegram' as const, uri: 'https://t.me/channel/10' };
    const resolved = await sources.resolve(source, context);
    expect(resolved.fileName).toBe('clip.mp4');
    expect((await sources.materialize(resolved, context)).fingerprint).toHaveLength(64);
    expect(fetcher.mock.calls[0]![1].redirect).toBe('error');
    expect(fetcher.mock.calls[2]![0]).toContain('/chats/chat/messages/10/media/m1');
    fetcher
      .mockResolvedValueOnce(Response.json({ data: { peer: { id: 'chat' } } }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    await expect(sources.resolve(source, context)).rejects.toThrow('exactly one');
    await expect(new NodeSources({ files }).resolve(source, context)).rejects.toThrow(
      'TELEGRAM_PROXY_URL',
    );
    fetcher.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(sources.resolve(source, context)).rejects.toThrow('500');
  });
});
