import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publicUrl, safeRequest } from '../src/safe-fetch.js';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:http', () => ({ request: mocks.request }));
vi.mock('node:https', () => ({ request: mocks.request }));
beforeEach(() => {
  mocks.lookup.mockReset().mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  mocks.request.mockReset();
});
function response(statusCode: number, headers: Record<string, string> = {}) {
  return Object.assign(Readable.from([]), { statusCode, headers });
}
function respond(...responses: ReturnType<typeof response>[]) {
  for (const item of responses)
    mocks.request.mockImplementationOnce(
      (_url: URL, _options: unknown, callback: (response: unknown) => void) => {
        const emitter = new EventEmitter() as EventEmitter & { end: () => void };
        emitter.end = () => callback(item);
        return emitter;
      },
    );
}
describe('pinned HTTP transport', () => {
  it('pins the validated DNS address and revalidates redirect destinations', async () => {
    respond(response(302, { location: 'https://second.example/media' }), response(200));
    const result = await safeRequest('https://first.example/media', {
      signal: new AbortController().signal,
    });
    expect(result.statusCode).toBe(200);
    expect(mocks.lookup.mock.calls.map((call) => call[0])).toEqual([
      'first.example',
      'second.example',
    ]);
    const options = mocks.request.mock.calls[0]![1];
    const callback = vi.fn();
    options.lookup('first.example', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '1.1.1.1', 4);
    expect(options.family).toBe(4);
  });
  it('rejects mixed private DNS results and redirects into private networks', async () => {
    mocks.lookup.mockResolvedValueOnce([
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(publicUrl('https://mixed.example')).rejects.toThrow('Private');
    expect(mocks.request).not.toHaveBeenCalled();
    respond(response(302, { location: 'http://169.254.169.254/latest/meta-data' }));
    await expect(
      safeRequest('https://public.example', { signal: new AbortController().signal }),
    ).rejects.toThrow('Private');
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('rejects redirect loops, HTTP failures, missing DNS answers and transport errors', async () => {
    respond(response(302, { location: '/loop' }), response(302, { location: '/loop' }));
    await expect(
      safeRequest('https://public.example', {
        signal: new AbortController().signal,
        maxRedirects: 1,
      }),
    ).rejects.toThrow('redirects');
    respond(response(404));
    await expect(
      safeRequest('https://public.example', { signal: new AbortController().signal }),
    ).rejects.toThrow('404');
    mocks.lookup.mockResolvedValueOnce([]);
    await expect(publicUrl('https://empty.example')).rejects.toThrow();
    mocks.request.mockImplementationOnce(() => {
      const emitter = new EventEmitter() as EventEmitter & { end: () => void };
      emitter.end = () => emitter.emit('error', new Error('connection failed'));
      return emitter;
    });
    await expect(
      safeRequest('http://public.example', { signal: new AbortController().signal }),
    ).rejects.toThrow('connection failed');
  });
});
