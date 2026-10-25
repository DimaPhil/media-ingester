import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPublicAddress, publicUrl, safeRequest, saveStream } from '../src/safe-fetch.js';
import { driveId, telegramReference } from '../src/sources.js';

describe('source network policies', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.1.1',
    '192.168.0.1',
    '169.254.169.254',
    '100.100.100.200',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2002:7f00:1::',
    'garbage',
  ])('blocks private/reserved %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('permits public %s', (address) =>
    expect(isPublicAddress(address)).toBe(true),
  );
  it('rejects unsupported URLs, credentials and private destinations before connection', async () => {
    await expect(publicUrl('not-a-url')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(publicUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(publicUrl('https://user:pass@example.com')).rejects.toThrow();
    await expect(publicUrl('http://[::1]/')).rejects.toThrow();
    await expect(
      safeRequest('http://127.0.0.1/', { signal: new AbortController().signal }),
    ).rejects.toThrow('Private');
    const result = await publicUrl('https://1.1.1.1/file');
    expect(result.address).toBe('1.1.1.1');
    expect(result.family).toBe(4);
  });
  it('limits streamed bytes without buffering the whole source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stream-'));
    try {
      await saveStream(
        Readable.from([Buffer.from('123'), Buffer.from('45')]),
        join(root, 'good'),
        5,
        new AbortController().signal,
      );
      expect(await readFile(join(root, 'good'), 'utf8')).toBe('12345');
      await expect(
        saveStream(
          Readable.from([Buffer.from('123456')]),
          join(root, 'bad'),
          5,
          new AbortController().signal,
        ),
      ).rejects.toThrow('limit');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('parses only supported Google Drive and Telegram sources', () => {
    expect(() => driveId('not-a-url')).toThrow('absolute');
    expect(() => telegramReference('not-a-url')).toThrow('absolute');
    expect(driveId('https://drive.google.com/file/d/abc_123/view')).toBe('abc_123');
    expect(driveId('https://drive.google.com/open?id=abc')).toBe('abc');
    expect(() => driveId('https://evil.com/file/d/abc')).toThrow();
    expect(() => driveId('https://drive.google.com/drive/folders/abc')).toThrow();
    expect(telegramReference('https://t.me/channel/12')).toEqual({ chat: '@channel', message: 12 });
    expect(telegramReference('https://t.me/c/123/14')).toEqual({ chat: '-100123', message: 14 });
    expect(() => telegramReference('https://evil.com/channel/12')).toThrow();
    expect(() => telegramReference('https://t.me/channel/abc')).toThrow();
  });
});
