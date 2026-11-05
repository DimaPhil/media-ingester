import type {
  HistoryPage,
  Input,
  JobView,
  OperationId,
  Output,
  ProcessedMedia,
  ProcessedMediaSummary,
} from '@media-ingest/contracts';

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error('Missing admin element ' + id);
  return element as T;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

const configuration = JSON.parse(byId('admin-configuration').textContent ?? '{}') as {
  catalog: Record<OperationId, { method: string; path: string }>;
  contractHash: string;
};
const dialog = byId<HTMLDialogElement>('result-dialog');
const records = new Map<string, ProcessedMediaSummary>();
let token = '';
let session = 0;
let resultRequest = 0;
let refreshPending = false;
let historyPending = false;
let historyExpanded = false;
let renderedHistory = '';
let renderedFailures = '';
let nextBefore: string | null = null;
let polling: ReturnType<typeof setInterval> | undefined;
let requests = new AbortController();

function notice(message: string, error = false) {
  const element = byId('notice');
  element.textContent = message;
  element.className = error ? 'notice error' : 'notice';
  element.hidden = !message;
}

function signOut(message = '') {
  session++;
  resultRequest++;
  requests.abort();
  requests = new AbortController();
  token = '';
  refreshPending = false;
  historyPending = false;
  historyExpanded = false;
  renderedHistory = '';
  renderedFailures = '';
  clearInterval(polling);
  records.clear();
  nextBefore = null;
  byId('workspace').hidden = true;
  byId('login').hidden = false;
  byId('sign-out').hidden = true;
  byId('server-version').textContent = '';
  byId('last-refresh').textContent = 'Connecting';
  byId<HTMLInputElement>('owner-token').value = '';
  byId('history-rows').replaceChildren();
  byId('active-jobs').replaceChildren();
  byId('failed-jobs').replaceChildren();
  byId('result-content').replaceChildren();
  byId('result-title').textContent = '';
  byId('result-source').replaceChildren();
  if (dialog.open) dialog.close();
  notice(message, Boolean(message));
}

async function call<K extends OperationId>(id: K, input: Input<K>): Promise<Output<K>> {
  const currentSession = session;
  const operation = configuration.catalog[id];
  let path = operation.path;
  const parameters = { ...input } as Record<string, unknown>;
  if (path.includes(':id')) {
    path = path.replace(':id', encodeURIComponent(String(parameters.id)));
    delete parameters.id;
  }
  const headers: Record<string, string> = { Authorization: 'Bearer ' + token };
  const options: RequestInit = {
    method: operation.method,
    headers,
    signal: requests.signal,
    credentials: 'omit',
    redirect: 'error',
  };
  if (operation.method === 'GET') {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined) query.set(key, String(value));
    }
    if (query.size) path += '?' + query.toString();
  } else {
    headers['content-type'] = 'application/json';
    headers['x-media-contract'] = configuration.contractHash;
    options.body = JSON.stringify(parameters);
  }
  const response = await fetch(path, options);
  if (currentSession !== session) throw new DOMException('Session changed', 'AbortError');
  if (response.status === 401) {
    signOut('Your token was not accepted. Enter the owner API token to reconnect.');
    throw new DOMException('Signed out', 'AbortError');
  }
  if (!response.ok) {
    if (response.status === 403)
      throw new Error('This token does not have the required permission.');
    if (response.status === 409)
      throw new Error('The request conflicted. Refresh or reload before retrying.');
    if (response.status === 404) throw new Error('This record is no longer available.');
    throw new Error('The service could not complete this request. Try again.');
  }
  const value = (await response.json()) as Output<K>;
  if (currentSession !== session) throw new DOMException('Session changed', 'AbortError');
  return value;
}

function report(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return;
  notice(
    error instanceof Error && !(error instanceof TypeError)
      ? error.message
      : 'Cannot reach Media Ingest. Check your connection and try again.',
    true,
  );
}

function shortSource(job: Pick<JobView, 'request'> & { media?: ProcessedMedia['media'] }): string {
  if (job.media) {
    const title = job.media.source.metadata.title;
    if (typeof title === 'string' && title) return title;
    if (job.media.source.fileName) return job.media.source.fileName;
  }
  const source = job.request.source;
  if (source.kind === 'upload') return 'Uploaded media · ' + source.uri.slice(0, 8);
  return source.uri;
}

function kindLabel(kind: string): string {
  return kind === 'transcription' ? 'Transcript' : 'Understanding';
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function durationLabel(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

function empty(title: string, description: string): HTMLElement {
  const element = node('div', undefined, 'empty');
  element.append(node('strong', title), node('span', description));
  return element;
}

function renderActive(running: JobView[], queued: JobView[]) {
  byId('running-count').textContent = String(running.length) + (running.length === 100 ? '+' : '');
  byId('queued-count').textContent = String(queued.length) + (queued.length === 100 ? '+' : '');
  const container = byId('active-jobs');
  container.replaceChildren();
  for (const job of [...running, ...queued]) {
    const row = node('div', undefined, 'job');
    const identity = node('div');
    identity.append(
      node('div', shortSource(job), 'job-title'),
      node(
        'div',
        kindLabel(job.request.kind) +
          ' · ' +
          job.request.provider +
          ' · ' +
          dateLabel(job.createdAt),
        'job-meta',
      ),
    );
    const progress = node('div', undefined, 'progress-wrap');
    progress.append(
      node(
        'div',
        job.status === 'queued'
          ? 'Queued'
          : job.totalChunks
            ? job.completedChunks + ' / ' + job.totalChunks + ' chunks'
            : 'Preparing media',
        'progress-label',
      ),
    );
    if (job.status === 'running') {
      const bar = node('progress');
      bar.setAttribute('aria-label', 'Processing progress for ' + shortSource(job));
      bar.max = Math.max(1, job.totalChunks);
      if (job.totalChunks) bar.value = job.completedChunks;
      progress.append(bar);
    }
    row.append(identity, progress);
    container.append(row);
  }
  if (!running.length && !queued.length) {
    container.append(empty('The queue is clear.', 'New jobs will appear here while they process.'));
  }
}

function renderFailed(jobs: JobView[]) {
  const signature = JSON.stringify(jobs);
  if (signature === renderedFailures) return;
  renderedFailures = signature;
  byId('failed-count').textContent = String(jobs.length) + (jobs.length === 10 ? '+' : '');
  byId('failures').hidden = jobs.length === 0;
  const container = byId('failed-jobs');
  container.replaceChildren();
  for (const job of jobs) {
    const row = node('div', undefined, 'failure-row');
    const identity = node('div');
    const title = node('div', undefined, 'failure-title');
    title.append(node('strong', shortSource(job)), node('span', 'Failed', 'badge failed'));
    identity.append(
      title,
      node('div', job.error?.message ?? 'Processing did not complete.', 'failure-message'),
      node('div', job.request.provider + ' · ' + dateLabel(job.updatedAt), 'job-meta'),
    );
    const retry = node('button', 'Retry job');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      retry.disabled = true;
      void call('retry', { id: job.id })
        .then(async () => {
          notice('Job queued for another attempt.');
          await refresh();
        })
        .catch(report)
        .finally(() => {
          retry.disabled = false;
        });
    });
    row.append(identity, retry);
    container.append(row);
  }
}

function renderHistory() {
  const signature = JSON.stringify([[...records.values()], nextBefore]);
  if (signature === renderedHistory) return;
  renderedHistory = signature;
  const body = byId('history-rows');
  body.replaceChildren();
  for (const record of records.values()) {
    const row = node('tr');
    const media = node('td', undefined, 'media-name');
    const title = node('button', shortSource(record));
    title.type = 'button';
    title.addEventListener('click', () => void openResult(record.id));
    const sourceKind = record.request.source.kind.replaceAll('_', ' ');
    media.append(title, node('span', sourceKind, 'media-sub'));
    const kind = node('td');
    kind.append(node('span', kindLabel(record.request.kind), 'badge ' + record.request.kind));
    const action = node('td');
    const open = node('button', 'Open');
    open.type = 'button';
    open.setAttribute('aria-label', 'Open result for ' + shortSource(record));
    open.addEventListener('click', () => void openResult(record.id));
    action.append(open);
    row.append(
      media,
      kind,
      node('td', record.request.provider, 'provider'),
      node('td', dateLabel(record.completedAt), 'no-wrap'),
      action,
    );
    body.append(row);
  }
  byId('history-empty').hidden = records.size > 0;
  byId('history-count').textContent =
    records.size + (records.size === 1 ? ' result' : ' results') + (nextBefore ? ' loaded' : '');
  byId('load-more').hidden = !nextBefore;
}

async function loadOlderHistory() {
  if (historyPending || !nextBefore) return;
  historyPending = true;
  const currentSession = session;
  const button = byId<HTMLButtonElement>('load-more');
  button.disabled = true;
  try {
    const page: HistoryPage = await call('history', {
      limit: 20,
      before: nextBefore,
    });
    for (const record of page.items) records.set(record.id, record);
    historyExpanded = true;
    nextBefore = page.nextBefore;
    renderHistory();
  } finally {
    if (currentSession === session) {
      historyPending = false;
      button.disabled = false;
    }
  }
}

async function refresh(resetHistory = false) {
  if (!token || refreshPending) return;
  refreshPending = true;
  const currentSession = session;
  byId('active-jobs').setAttribute('aria-busy', 'true');
  byId<HTMLButtonElement>('refresh').disabled = true;
  try {
    const [running, queued, failed] = await Promise.all([
      call('list', { status: 'running', limit: 100 }),
      call('list', { status: 'queued', limit: 100 }),
      call('list', { status: 'failed', limit: 10 }),
    ]);
    renderActive(running.items, queued.items);
    renderFailed(failed.items);
    if (!historyPending && (!historyExpanded || resetHistory)) {
      historyPending = true;
      try {
        const latest = await call('history', { limit: 20 });
        records.clear();
        for (const record of latest.items) records.set(record.id, record);
        nextBefore = latest.nextBefore;
        historyExpanded = false;
      } finally {
        if (currentSession === session) historyPending = false;
      }
    }
    renderHistory();
    byId('last-refresh').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (error) {
    report(error);
  } finally {
    if (currentSession === session) {
      refreshPending = false;
      byId('active-jobs').setAttribute('aria-busy', 'false');
      byId<HTMLButtonElement>('refresh').disabled = false;
    }
  }
}

function sourceLink(uri: string): HTMLElement | null {
  try {
    const url = new URL(uri);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const link = node('a', 'Open original source ↗', 'source-link');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  } catch {
    return null;
  }
}

function download(content: string, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = node('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderResult(record: ProcessedMedia) {
  byId('result-title').textContent = shortSource(record);
  const source = byId('result-source');
  source.replaceChildren();
  const link = sourceLink(record.request.source.uri);
  if (link) source.append(link);
  const container = byId('result-content');
  container.replaceChildren();
  const fields = [
    ['Output', kindLabel(record.request.kind)],
    ['Provider', record.result.provider],
    ['Model', record.result.model],
    ['Processed', dateLabel(record.completedAt)],
    ['Language', record.result.detectedLanguage ?? 'Unspecified'],
    ['Duration', record.media ? durationLabel(record.media.inspection.durationMs) : 'Unavailable'],
    ['Format', record.media?.source.mimeType ?? 'Unspecified'],
    [
      'Size',
      record.media?.sizeBytes === undefined
        ? 'Unavailable'
        : new Intl.NumberFormat().format(record.media.sizeBytes) + ' bytes',
    ],
    ['Media ID', record.mediaId],
  ];
  const info = node('dl', undefined, 'detail-grid');
  for (const [label, value] of fields) {
    const item = node('div');
    item.append(node('dt', label), node('dd', value));
    info.append(item);
  }
  const tools = node('div', undefined, 'result-tools');
  const copy = node('button', 'Copy output');
  copy.type = 'button';
  copy.addEventListener('click', () => {
    if (!navigator.clipboard) {
      notice('Copy is unavailable. Use Download text instead.', true);
      return;
    }
    void navigator.clipboard
      .writeText(record.result.text)
      .then(() => notice('Output copied.'))
      .catch(() => notice('Copy is unavailable. Use Download text instead.', true));
  });
  const text = node('button', 'Download text');
  text.type = 'button';
  text.addEventListener('click', () =>
    download(record.result.text, record.id + '.txt', 'text/plain;charset=utf-8'),
  );
  const json = node('button', 'Download JSON');
  json.type = 'button';
  json.addEventListener('click', () =>
    download(JSON.stringify(record, null, 2), record.id + '.json', 'application/json'),
  );
  tools.append(copy, text, json);
  container.append(
    info,
    tools,
    node('h3', 'Output'),
    node('pre', record.result.text, 'result-text'),
  );
  if (record.result.translatedText) {
    container.append(
      node('h3', 'Translation'),
      node('pre', record.result.translatedText, 'result-text'),
    );
  }
  const timing = [...record.result.segments, ...record.result.timeRanges];
  if (timing.length) {
    const details = node('details');
    details.append(node('summary', 'Timestamps · ' + timing.length));
    const table = node('table', undefined, 'details-table');
    table.setAttribute('aria-label', 'Output timestamps');
    for (const range of timing) {
      const row = node('tr');
      row.append(
        node('td', durationLabel(range.startMs) + ' – ' + durationLabel(range.endMs), 'no-wrap'),
        node('td', 'text' in range ? range.text : (range.label ?? '')),
      );
      table.append(row);
    }
    details.append(table);
    container.append(details);
  }
  const metadata = node('details');
  metadata.append(
    node('summary', 'Media details and identifiers'),
    node(
      'pre',
      JSON.stringify(
        {
          id: record.id,
          mediaId: record.mediaId,
          fingerprint: record.fingerprint,
          source: record.media?.source ?? record.request.source,
          inspection: record.media?.inspection ?? null,
          sizeBytes: record.media?.sizeBytes,
          createdAt: record.createdAt,
          completedAt: record.completedAt,
          prompt: record.request.prompt,
          provenance: record.result.provenance,
        },
        null,
        2,
      ),
      'mono',
    ),
  );
  container.append(metadata);
}

async function openResult(id: string) {
  const request = ++resultRequest;
  byId('result-title').textContent = 'Loading result';
  byId('result-source').replaceChildren();
  byId('result-content').replaceChildren(node('p', 'Retrieving the saved output…'));
  if (!dialog.open) dialog.showModal();
  try {
    const record = await call('result', { id });
    if (request === resultRequest) renderResult(record);
  } catch (error) {
    if (request === resultRequest && token) {
      byId('result-content').replaceChildren(
        node('p', 'Could not load this result. Close and try again.'),
      );
    }
    report(error);
  }
}

byId('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const field = byId<HTMLInputElement>('owner-token');
  const value = field.value.trim();
  if (!value) return;
  signOut();
  token = value;
  const currentSession = session;
  const button = byId('login-form').querySelector('button')!;
  button.disabled = true;
  void call('info', {})
    .then(async (info) => {
      if (currentSession !== session) return;
      byId('login').hidden = true;
      byId('workspace').hidden = false;
      byId('sign-out').hidden = false;
      byId('server-version').textContent = 'v' + info.version;
      notice('');
      await refresh(true);
      if (currentSession === session && token) {
        polling = setInterval(() => {
          if (!document.hidden) void refresh();
        }, 4000);
      }
    })
    .catch(report)
    .finally(() => {
      button.disabled = false;
    });
});
byId('sign-out').addEventListener('click', () => signOut());
byId('refresh').addEventListener('click', () => void refresh(true));
byId('load-more').addEventListener('click', () => void loadOlderHistory().catch(report));
byId('close-result').addEventListener('click', () => {
  resultRequest++;
  dialog.close();
});
dialog.addEventListener('cancel', () => {
  resultRequest++;
});
