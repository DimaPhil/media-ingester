import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { contractDocument, RELEASE_VERSION } from '@media-ingest/contracts';
import { MediaClient, validateBaseUrl } from '../src/index.js';

const contractHash = createHash('sha256').update(JSON.stringify(contractDocument())).digest('hex');
const request = {
  kind: 'transcription',
  source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
  provider: 'openai',
} as const;
const job = {
  id: '64e2f3cb-50ae-4ee4-9d7b-65150ba23488',
  request,
  status: 'queued',
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
  completedChunks: 0,
  totalChunks: 0,
  attempt: 0,
  result: null,
  error: null,
};
const info = { version: RELEASE_VERSION, contractHash };
function mockClient(responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!);
  return {
    client: new MediaClient({
      baseUrl: 'https://example.com',
      token: 'test-secret',
      fetch: fetcher,
    }),
    fetcher,
  };
}
describe('HTTP client', () => {
  it('checks fingerprint before every write and sends validated requests with bearer authentication', async () => {
    const { client, fetcher } = mockClient([
      Response.json(info),
      Response.json(job),
      Response.json(info),
      Response.json(job),
    ]);
    expect(await client.call('submit', { request })).toEqual(job);
    await client.call('retry', { id: job.id });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://example.com/v1/info',
      'https://example.com/v1/jobs',
      'https://example.com/v1/info',
      `https://example.com/v1/jobs/${job.id}/retry`,
    ]);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { authorization: 'Bearer test-secret', 'x-media-contract': contractHash },
      body: JSON.stringify({ request }),
    });
  });
  it('blocks writes on drift without submitting', async () => {
    const { client, fetcher } = mockClient([Response.json({ ...info, contractHash: 'different' })]);
    await expect(client.call('submit', { request })).rejects.toMatchObject({
      code: 'contract_mismatch',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('validates inputs before network access and rejects local server paths', async () => {
    const { client, fetcher } = mockClient([]);
    await expect(client.call('get', { id: 'no' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      client.call('submit', {
        request: { ...request, source: { kind: 'local_file', uri: '/secret' } },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('encodes query defaults and validates responses', async () => {
    const { client, fetcher } = mockClient([
      Response.json({ items: [] }),
      Response.json({ wrong: true }),
    ]);
    await client.call('list', {});
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://example.com/v1/jobs?limit=20');
    await expect(client.call('get', { id: job.id })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
  it.each([401, 403, 404, 409, 500])(
    'maps HTTP %s without echoing untrusted response bodies',
    async (status) => {
      const { client } = mockClient([new Response('test-secret', { status })]);
      await expect(client.call('info', {})).rejects.toMatchObject({ status });
    },
  );
  it('handles malformed JSON and network failure', async () => {
    const { client, fetcher } = mockClient([new Response('not-json')]);
    await expect(client.call('info', {})).rejects.toMatchObject({ code: 'invalid_response' });
    fetcher.mockRejectedValueOnce(new Error('test-secret'));
    await expect(client.call('info', {})).rejects.toMatchObject({ code: 'network_error' });
  });
  it('allows localhost and HTTPS but rejects credential-bearing or insecure remote URLs', () => {
    expect(validateBaseUrl('http://127.0.0.1:4000/')).toBe('http://127.0.0.1:4000');
    expect(validateBaseUrl('http://[::1]:4000')).toBe('http://[::1]:4000');
    for (const url of [
      'http://example.com',
      'https://u:p@example.com',
      'https://example.com?q=x',
      'https://example.com#x',
    ])
      expect(() => validateBaseUrl(url)).toThrow();
    expect(() => new MediaClient({ baseUrl: 'https://example.com', token: '' })).toThrow();
  });
});
