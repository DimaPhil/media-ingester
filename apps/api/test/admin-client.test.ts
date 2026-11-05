// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobView, ProcessedMedia, ProcessedMediaSummary } from '@media-ingest/contracts';
import { adminPage } from '../src/admin-page.js';

const id = '11111111-1111-4111-8111-111111111111';
const olderId = '22222222-2222-4222-8222-222222222222';
const token = 'browser-test-owner-token';
let record: ProcessedMedia;
let jobs: JobView[];
let history: ProcessedMediaSummary[];
let older: ProcessedMediaSummary[];
let nextBefore: string | null;
let infoStatus: number;
let retryStatus: number;
const fetcher = vi.fn();

function summary(value: ProcessedMedia): ProcessedMediaSummary {
  const { result, ...rest } = value;
  return { ...rest, preview: result.text.slice(0, 240) };
}
function element<T extends HTMLElement = HTMLElement>(name: string): T {
  return document.getElementById(name) as T;
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((item) => item.textContent === text);
  if (!found) throw new Error('Missing button ' + text);
  return found;
}
async function signIn() {
  element<HTMLInputElement>('owner-token').value = token;
  element('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(element('last-refresh').textContent).toContain('Updated'));
}
async function openResult() {
  button('Open').click();
  await vi.waitFor(() =>
    expect(element('result-content').textContent).toContain(record.result.text),
  );
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = adminPage().split('<body>')[1]!.split('</body>')[0]!;
  infoStatus = 200;
  retryStatus = 200;
  nextBefore = null;
  record = {
    id,
    mediaId: 'native-video-id',
    fingerprint: 'content-hash',
    request: {
      kind: 'understanding',
      source: { kind: 'youtube', uri: 'https://youtube.com/watch?v=fixture' },
      provider: 'google-gemini',
      model: 'fixture-model',
      prompt: 'Describe the changes',
    },
    media: {
      source: {
        source: { kind: 'youtube', uri: 'https://youtube.com/watch?v=fixture' },
        fileName: 'Recording.mp4',
        metadata: { title: 'Product demonstration' },
      },
      inspection: { durationMs: 42_000, hasAudio: true, hasVideo: true },
    },
    createdAt: '2026-11-01T10:00:00.000Z',
    completedAt: '2026-11-01T10:01:00.000Z',
    result: {
      kind: 'understanding',
      provider: 'google-gemini',
      model: 'fixture-model',
      text: 'A person demonstrates the application.',
      translatedText: 'Une personne présente une application.',
      detectedLanguage: 'en',
      segments: [{ startMs: 0, endMs: 1000, text: 'First step' }],
      timeRanges: [{ startMs: 1000, endMs: 2000, label: 'Application opens' }],
    },
  };
  jobs = [
    {
      id,
      request: record.request,
      status: 'running',
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
      completedChunks: 1,
      totalChunks: 3,
      attempt: 1,
      result: null,
      error: null,
    },
  ];
  history = [summary(record)];
  older = [summary({ ...record, id: olderId, completedAt: '2026-10-01T10:00:00.000Z' })];
  fetcher.mockReset().mockImplementation(async (path: string, init: RequestInit) => {
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ' + token);
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/v1/info')
      return Response.json({ version: '1.1.0' }, { status: infoStatus });
    if (url.pathname === '/v1/jobs') {
      return Response.json({
        items: jobs.filter((job) => job.status === url.searchParams.get('status')),
      });
    }
    if (url.pathname === '/v1/history') {
      return Response.json({
        items: url.searchParams.get('before') ? older : history,
        nextBefore: url.searchParams.get('before') ? null : nextBefore,
      });
    }
    if (url.pathname.endsWith('/retry')) return Response.json({}, { status: retryStatus });
    return Response.json(record);
  });
  vi.stubGlobal('fetch', fetcher);
  await import('../src/admin-client.js');
});

afterEach(() => {
  element('sign-out')?.click();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('admin workspace', () => {
  it('waits for login, keeps credentials in memory and displays active work and history', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    expect(fetcher).not.toHaveBeenCalled();
    expect(element('workspace').hidden).toBe(true);
    await signIn();
    expect(element<HTMLInputElement>('owner-token').value).toBe('');
    expect(storage).not.toHaveBeenCalled();
    expect(element('login').hidden).toBe(true);
    expect(element('running-count').textContent).toBe('1');
    expect(element('active-jobs').textContent).toContain('1 / 3 chunks');
    expect(element('history-rows').textContent).toContain('Product demonstration');
    expect(element('server-version').textContent).toBe('v1.1.0');
    expect(document.querySelector('progress')?.getAttribute('aria-label')).toContain(
      'Processing progress',
    );
    element('sign-out').click();
    expect(element('workspace').hidden).toBe(true);
    expect(element('history-rows').textContent).toBe('');
  });

  it('renders completed results, translation, timestamps and metadata without job details', async () => {
    jobs = [];
    await signIn();
    expect(element('active-jobs').textContent).toContain('The queue is clear');
    await openResult();
    expect(element<HTMLDialogElement>('result-dialog').open).toBe(true);
    expect(element('result-content').textContent).toContain('Une personne');
    expect(element('result-content').textContent).toContain('Application opens');
    expect(element('result-content').textContent).toContain('native-video-id');
    expect(element('result-content').textContent).toContain('0:42');
    expect(element('result-source').querySelector('a')?.rel).toContain('noreferrer');
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    button('Copy output').click();
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(record.result.text));
    const save = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    button('Download text').click();
    button('Download JSON').click();
    expect(save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    element('close-result').click();
    expect(element<HTMLDialogElement>('result-dialog').open).toBe(false);
  });

  it('escapes source titles and output text and excludes unsafe source links', async () => {
    record.media!.source.metadata.title = '<img src=x onerror=alert(1)>';
    record.request.source.uri = 'javascript:alert(1)';
    record.result.text = '<script>alert("fixture")</script>';
    history = [summary(record)];
    await signIn();
    await openResult();
    expect(element('history-rows').querySelector('img')).toBeNull();
    expect(element('result-content').querySelector('script')).toBeNull();
    expect(element('result-content').textContent).toContain(record.result.text);
    expect(element('result-source').querySelector('a')).toBeNull();
  });

  it('loads older result pages, preserves them during polling and refreshes the first page explicitly', async () => {
    nextBefore = id;
    await signIn();
    element('load-more').click();
    await vi.waitFor(() => expect(element('history-rows').children).toHaveLength(2));
    expect(fetcher.mock.calls.some(([path]) => String(path).includes('before=' + id))).toBe(true);
    jobs = [];
    await vi.advanceTimersByTimeAsync(4000);
    expect(element('running-count').textContent).toBe('0');
    expect(element('history-rows').children).toHaveLength(2);
    element('refresh').click();
    await vi.waitFor(() => expect(element('history-rows').children).toHaveLength(1));
  });

  it('preserves keyboard focus on unchanged actions during polling and renders again after login', async () => {
    jobs[0]!.status = 'failed';
    await signIn();
    const retry = button('Retry job');
    retry.focus();
    await vi.advanceTimersByTimeAsync(4000);
    expect(document.activeElement).toBe(retry);
    const open = button('Open');
    open.focus();
    await vi.advanceTimersByTimeAsync(4000);
    expect(document.activeElement).toBe(open);
    element('sign-out').click();
    await signIn();
    expect(element('history-rows').children).toHaveLength(1);
    expect(element('failed-jobs').children).toHaveLength(1);
  });

  it('retries failed jobs only after a click and sends the current contract fingerprint', async () => {
    jobs[0]!.status = 'failed';
    jobs[0]!.error = { code: 'fixture', message: 'Source unavailable', retryable: true };
    await signIn();
    expect(element('failures').hidden).toBe(false);
    expect(element('failed-jobs').textContent).toContain('Source unavailable');
    expect(fetcher.mock.calls.some(([path]) => String(path).endsWith('/retry'))).toBe(false);
    button('Retry job').click();
    await vi.waitFor(() => expect(element('notice').textContent).toContain('queued'));
    const retry = fetcher.mock.calls.find(([path]) => String(path).endsWith('/retry'))!;
    expect(retry[1]).toMatchObject({ method: 'POST', body: '{}' });
    expect((retry[1].headers as Record<string, string>)['x-media-contract']).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it.each([403, 404, 409, 503])('shows a bounded error for HTTP %s', async (status) => {
    infoStatus = status;
    element<HTMLInputElement>('owner-token').value = token;
    element('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(element('notice').hidden).toBe(false));
    expect(element('notice').textContent).not.toContain(token);
    expect(element('workspace').hidden).toBe(true);
  });

  it('returns to login on 401 and prevents late responses from restoring private data after logout', async () => {
    await signIn();
    let resolve: ((value: Response) => void) | undefined;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    button('Open').click();
    expect(resolve).toBeDefined();
    element('sign-out').click();
    resolve!(Response.json(record));
    await vi.waitFor(() => expect(element('login').hidden).toBe(false));
    expect(element('result-content').textContent).toBe('');
    expect(element<HTMLDialogElement>('result-dialog').open).toBe(false);
    infoStatus = 401;
    element<HTMLInputElement>('owner-token').value = token;
    element('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(element('notice').textContent).toContain('not accepted'));
    expect(element('workspace').hidden).toBe(true);
  });

  it('shows empty history and sanitizes transport errors', async () => {
    jobs = [];
    history = [];
    await signIn();
    expect(element('history-empty').hidden).toBe(false);
    fetcher.mockRejectedValueOnce(new TypeError('private-upstream-body'));
    element('refresh').click();
    await vi.waitFor(() => expect(element('notice').textContent).toContain('Cannot reach'));
    expect(element('notice').textContent).not.toContain('private-upstream-body');
  });

  it('shows older uploaded results with missing metadata and recovers from a result lookup error', async () => {
    record.media = null;
    record.request = {
      kind: 'transcription',
      provider: 'openai',
      source: { kind: 'upload', uri: olderId },
    };
    record.result = {
      kind: 'transcription',
      provider: 'openai',
      model: 'fixture',
      text: 'Old saved words',
      segments: [],
      timeRanges: [],
      detectedLanguage: null,
    };
    history = [summary(record)];
    await signIn();
    expect(element('history-rows').textContent).toContain('Uploaded media');
    fetcher.mockResolvedValueOnce(Response.json({}, { status: 404 }));
    button('Open').click();
    await vi.waitFor(() => expect(element('notice').textContent).toContain('no longer available'));
    element('close-result').click();
    await openResult();
    expect(element('result-content').textContent).toContain('Unavailable');
    expect(element('result-content').textContent).toContain('Unspecified');
    expect(element('result-source').querySelector('a')).toBeNull();
  });
});
