import { describe, expect, it } from 'vitest';
import { YtDlpSourceRegistry } from '../src/source-registry.js';

describe('download source registry', () => {
  const registry = new YtDlpSourceRegistry();
  it.each([
    ['https://youtu.be/abc', 'youtube'],
    ['https://youtube.com/watch?v=abc', 'youtube'],
    ['https://www.youtube.com/shorts/abc', 'youtube'],
    ['https://instagram.com/p/abc/', 'instagram'],
    ['https://www.instagram.com/reel/abc/', 'instagram'],
    ['https://x.com/person/status/123', 'x'],
    ['https://twitter.com/i/status/123/video/1', 'x'],
  ])('maps %s to %s without a catch-all extractor', (uri, id) => {
    const { site } = registry.select({ kind: 'yt_dlp', uri });
    expect(site.id).toBe(id);
    expect(registry.extractorArgument(site)).toMatch(/^\^[A-Za-z]+\$$/);
  });
  it.each([
    'https://youtube.com/channel/name',
    'https://youtu.be/a/b',
    'https://youtube.com/watch?v=a&list=b',
    'https://instagram.com/person/',
    'https://x.com/person',
    'https://x.com/person/status/123/followers',
  ])('rejects collections and non-post URL %s', (uri) => {
    expect(() => registry.select({ kind: 'yt_dlp', uri })).toThrow();
  });
  it('rejects unknown hosts, mismatched named providers and unsafe URL forms', () => {
    for (const uri of [
      'https://youtube.com.evil.example/watch?v=a',
      'file:///tmp/video',
      'https://user:pass@youtube.com/watch?v=a',
      'https://youtube.com:8443/watch?v=a',
      'not-a-url',
    ])
      expect(() => registry.select({ kind: 'yt_dlp', uri })).toThrow();
    expect(() => registry.select({ kind: 'youtube', uri: 'https://instagram.com/p/a' })).toThrow(
      'does not belong',
    );
    expect(() =>
      registry.select({ kind: 'yt_dlp', uri: 'https://threads.net/@person/post/a' }),
    ).toThrow('Threads');
  });
  it('requires explicit custom extractor policies without overriding built-ins', () => {
    const custom = new YtDlpSourceRegistry([
      { id: 'vimeo', hosts: ['vimeo.com'], extractors: ['vimeo'], pathPattern: '^/[0-9]+$' },
    ]);
    expect(custom.select({ kind: 'yt_dlp', uri: 'https://vimeo.com/123' }).site.id).toBe('vimeo');
    expect(
      custom.extractorArgument(
        custom.select({ kind: 'yt_dlp', uri: 'https://youtube.com/watch?v=a' }).site,
      ),
    ).toBe('^youtube$');
    for (const extractors of [[], ['all'], ['generic'], ['default'], ['.*'], ['-youtube']])
      expect(
        () => new YtDlpSourceRegistry([{ id: 'custom', hosts: ['example.com'], extractors }]),
      ).toThrow();
    expect(
      () =>
        new YtDlpSourceRegistry([
          { id: 'youtube', hosts: ['example.com'], extractors: ['Example'] },
        ]),
    ).toThrow();
    expect(
      () =>
        new YtDlpSourceRegistry([
          { id: 'custom', hosts: ['youtube.com'], extractors: ['Example'] },
        ]),
    ).toThrow();
    expect(
      () =>
        new YtDlpSourceRegistry([
          { id: 'custom', hosts: ['*.example.com'], extractors: ['Example'] },
        ]),
    ).toThrow();
    expect(
      () =>
        new YtDlpSourceRegistry([
          {
            id: 'custom',
            hosts: ['example.com'],
            extractors: ['Example'],
            pathPattern: 'unanchored',
          },
        ]),
    ).toThrow();
  });
});
