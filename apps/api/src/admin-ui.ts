export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Media Ingest Admin</title>
    <style>
      :root {
        --bg: #f5efe4;
        --paper: rgba(255, 252, 245, 0.92);
        --ink: #1e2430;
        --muted: #5e6777;
        --line: rgba(30, 36, 48, 0.1);
        --accent: #14532d;
        --accent-soft: rgba(20, 83, 45, 0.12);
        --running: #9a3412;
        --running-soft: rgba(154, 52, 18, 0.12);
        --failed: #991b1b;
        --failed-soft: rgba(153, 27, 27, 0.12);
        --queued: #1d4ed8;
        --queued-soft: rgba(29, 78, 216, 0.12);
        --shadow: 0 18px 60px rgba(41, 41, 33, 0.12);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--ink);
        font-family: "IBM Plex Sans", "Avenir Next", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(255,255,255,0.7), transparent 30%),
          linear-gradient(135deg, #efe2c7 0%, #f8f4eb 55%, #e2eadf 100%);
        min-height: 100vh;
      }

      .shell {
        max-width: 1400px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }

      .hero {
        display: grid;
        gap: 18px;
        grid-template-columns: 1.2fr 0.8fr;
        align-items: stretch;
        margin-bottom: 22px;
      }

      .panel {
        background: var(--paper);
        border: 1px solid var(--line);
        border-radius: 28px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }

      .hero-copy {
        padding: 28px;
        position: relative;
        overflow: hidden;
      }

      .hero-copy::after {
        content: "";
        position: absolute;
        inset: auto -30px -45px auto;
        width: 240px;
        height: 240px;
        border-radius: 999px;
        background: linear-gradient(135deg, rgba(20, 83, 45, 0.2), rgba(234, 179, 8, 0.1));
        filter: blur(4px);
      }

      h1 {
        margin: 0 0 10px;
        font-family: "IBM Plex Serif", Georgia, serif;
        font-size: clamp(2.2rem, 5vw, 3.8rem);
        line-height: 0.95;
        letter-spacing: -0.04em;
      }

      .subtitle {
        margin: 0;
        max-width: 56ch;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.55;
      }

      .hero-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 18px;
      }

      .meta-pill {
        border-radius: 999px;
        padding: 10px 14px;
        background: rgba(255,255,255,0.65);
        border: 1px solid var(--line);
        font-size: 0.9rem;
        color: var(--muted);
      }

      .overview {
        padding: 22px;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      .metric {
        padding: 16px;
        border-radius: 20px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.72);
      }

      .metric-label {
        color: var(--muted);
        font-size: 0.78rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .metric-value {
        margin-top: 6px;
        font-family: "IBM Plex Serif", Georgia, serif;
        font-size: 2rem;
      }

      .content {
        display: grid;
        grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.7fr);
        gap: 18px;
      }

      .workspace {
        padding: 18px;
      }

      .toolbar {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 10px;
        margin-bottom: 14px;
      }

      .field, button {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 16px;
        background: rgba(255,255,255,0.78);
        color: var(--ink);
        font: inherit;
        padding: 12px 14px;
      }

      button {
        cursor: pointer;
        background: linear-gradient(135deg, #1f7a43, #14532d);
        color: #f7fbf6;
        border: 0;
        font-weight: 600;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      thead th {
        text-align: left;
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
        padding: 12px;
      }

      tbody tr {
        cursor: pointer;
        transition: transform 120ms ease, background 120ms ease;
      }

      tbody tr:hover {
        background: rgba(255,255,255,0.62);
        transform: translateY(-1px);
      }

      td {
        padding: 12px;
        border-top: 1px solid var(--line);
        vertical-align: top;
        font-size: 0.95rem;
      }

      .id {
        font-family: "IBM Plex Mono", monospace;
        font-size: 0.82rem;
      }

      .uri {
        color: var(--muted);
        max-width: 26ch;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 7px 12px;
        border-radius: 999px;
        font-size: 0.8rem;
        font-weight: 600;
      }

      .chip.queued { color: var(--queued); background: var(--queued-soft); }
      .chip.running { color: var(--running); background: var(--running-soft); }
      .chip.completed { color: var(--accent); background: var(--accent-soft); }
      .chip.failed { color: var(--failed); background: var(--failed-soft); }

      .sidebar {
        padding: 18px;
        display: grid;
        gap: 18px;
      }

      .card-title {
        margin: 0 0 12px;
        font-size: 0.95rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }

      .stack {
        display: grid;
        gap: 10px;
      }

      .snapshot {
        padding: 14px;
        border-radius: 18px;
        background: rgba(255,255,255,0.72);
        border: 1px solid var(--line);
      }

      .snapshot strong {
        display: block;
        margin-bottom: 4px;
      }

      .detail-grid {
        display: grid;
        gap: 10px;
      }

      .detail-item {
        padding: 12px 14px;
        border-radius: 16px;
        background: rgba(255,255,255,0.72);
        border: 1px solid var(--line);
      }

      .detail-item code, .mono {
        font-family: "IBM Plex Mono", monospace;
        word-break: break-word;
      }

      .empty {
        padding: 22px;
        text-align: center;
        color: var(--muted);
      }

      .footer-note {
        margin-top: 16px;
        color: var(--muted);
        font-size: 0.88rem;
      }

      @media (max-width: 1080px) {
        .hero, .content { grid-template-columns: 1fr; }
        .toolbar { grid-template-columns: 1fr 1fr; }
      }

      @media (max-width: 720px) {
        .shell { padding: 18px 14px 28px; }
        .toolbar { grid-template-columns: 1fr; }
        thead { display: none; }
        table, tbody, tr, td { display: block; width: 100%; }
        td { border-top: 0; padding-top: 6px; padding-bottom: 6px; }
        tbody tr { border-top: 1px solid var(--line); padding: 10px 0; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        <div class="panel hero-copy">
          <h1>Media Ingest Control Room</h1>
          <p class="subtitle">
            Track queued, running, failed, and completed jobs in one place. Filter by provider or source, inspect step-level progress,
            and keep an eye on the most recent failures without leaving the server.
          </p>
          <div class="hero-meta">
            <div class="meta-pill">Auto-refresh every 5s</div>
            <div class="meta-pill">Live status + current step</div>
            <div class="meta-pill">Built for operator triage</div>
          </div>
        </div>
        <div class="panel overview" id="overview-cards"></div>
      </section>

      <section class="content">
        <div class="panel workspace">
          <div class="toolbar">
            <select id="status" class="field">
              <option value="">All statuses</option>
              <option value="queued">Queued</option>
              <option value="running">Running</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
            </select>
            <select id="kind" class="field">
              <option value="">All kinds</option>
              <option value="transcription">Transcription</option>
              <option value="understanding">Understanding</option>
            </select>
            <select id="provider" class="field">
              <option value="">All providers</option>
              <option value="openai">OpenAI</option>
              <option value="google-gemini">Google Gemini</option>
              <option value="google-speech">Google Speech</option>
            </select>
            <select id="sourceType" class="field">
              <option value="">All sources</option>
              <option value="youtube">YouTube</option>
              <option value="yt_dlp">yt-dlp</option>
              <option value="google_drive">Google Drive</option>
              <option value="telegram">Telegram</option>
              <option value="http">HTTP</option>
            </select>
            <button id="refresh" type="button">Refresh</button>
          </div>

          <table>
            <thead>
              <tr>
                <th>Operation</th>
                <th>Status</th>
                <th>Kind</th>
                <th>Provider</th>
                <th>Source</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody id="operations-body"></tbody>
          </table>
          <div class="footer-note">Selecting a row loads the full operation status and step timeline on the right.</div>
        </div>

        <aside class="sidebar">
          <div class="panel" style="padding: 18px">
            <h2 class="card-title">Selected Operation</h2>
            <div id="detail" class="detail-grid">
              <div class="empty">Choose an operation to inspect timings, current step, retries, and result/error details.</div>
            </div>
          </div>

          <div class="panel" style="padding: 18px">
            <h2 class="card-title">Latest Failures</h2>
            <div id="failures" class="stack"></div>
          </div>

          <div class="panel" style="padding: 18px">
            <h2 class="card-title">Latest Completed</h2>
            <div id="completed" class="stack"></div>
          </div>
        </aside>
      </section>
    </div>

    <script>
      const state = {
        selectedOperationId: null,
        timer: null,
      };

      const overviewCards = document.getElementById('overview-cards');
      const operationsBody = document.getElementById('operations-body');
      const detail = document.getElementById('detail');
      const failures = document.getElementById('failures');
      const completed = document.getElementById('completed');
      const statusField = document.getElementById('status');
      const kindField = document.getElementById('kind');
      const providerField = document.getElementById('provider');
      const sourceTypeField = document.getElementById('sourceType');

      function formatDate(value) {
        return new Date(value).toLocaleString();
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;');
      }

      function statusChip(status) {
        return '<span class="chip ' + status + '">' + escapeHtml(status) + '</span>';
      }

      async function fetchJson(path) {
        const response = await fetch(path, { headers: { accept: 'application/json' } });
        if (!response.ok) {
          throw new Error('Request failed: ' + response.status);
        }
        return response.json();
      }

      function queryString() {
        const params = new URLSearchParams();
        const values = {
          status: statusField.value,
          kind: kindField.value,
          provider: providerField.value,
          sourceType: sourceTypeField.value,
          limit: '50',
        };
        for (const [key, value] of Object.entries(values)) {
          if (value) params.set(key, value);
        }
        return params.toString();
      }

      function renderOverview(data) {
        const cards = [
          ['Total Jobs', data.counts.total],
          ['Active Now', data.activeOperations],
          ['Queued', data.counts.queued],
          ['Running', data.counts.running],
          ['Completed', data.counts.completed],
          ['Failed', data.counts.failed],
        ];
        overviewCards.innerHTML = cards.map(([label, value]) => (
          '<div class="metric"><div class="metric-label">' + escapeHtml(label) + '</div><div class="metric-value">' + escapeHtml(value) + '</div></div>'
        )).join('');
      }

      function renderSnapshotList(container, items, emptyText) {
        if (!items.length) {
          container.innerHTML = '<div class="empty">' + escapeHtml(emptyText) + '</div>';
          return;
        }
        container.innerHTML = items.map((item) => (
          '<div class="snapshot" data-operation-id="' + escapeHtml(item.id) + '">' +
            '<strong>' + escapeHtml(item.kind) + ' · ' + escapeHtml(item.provider) + '</strong>' +
            '<div class="id">' + escapeHtml(item.id) + '</div>' +
            '<div style="margin:8px 0">' + statusChip(item.status) + '</div>' +
            '<div class="uri">' + escapeHtml(item.sourceUri) + '</div>' +
          '</div>'
        )).join('');
        container.querySelectorAll('[data-operation-id]').forEach((element) => {
          element.addEventListener('click', () => {
            state.selectedOperationId = element.getAttribute('data-operation-id');
            loadSelectedOperation();
          });
        });
      }

      function renderOperations(items) {
        if (!items.length) {
          operationsBody.innerHTML = '<tr><td colspan="6"><div class="empty">No operations match the selected filters.</div></td></tr>';
          return;
        }
        operationsBody.innerHTML = items.map((item) => (
          '<tr data-operation-id="' + escapeHtml(item.id) + '">' +
            '<td><div class="id">' + escapeHtml(item.id) + '</div><div class="uri">' + escapeHtml(item.sourceUri) + '</div></td>' +
            '<td>' + statusChip(item.status) + '</td>' +
            '<td>' + escapeHtml(item.kind) + '<br><span class="uri">' + escapeHtml(item.currentStep || 'idle') + '</span></td>' +
            '<td>' + escapeHtml(item.provider) + '<br><span class="uri">' + escapeHtml(item.model || 'default model') + '</span></td>' +
            '<td>' + escapeHtml(item.sourceType) + '</td>' +
            '<td>' + escapeHtml(formatDate(item.updatedAt)) + '</td>' +
          '</tr>'
        )).join('');
        operationsBody.querySelectorAll('tr[data-operation-id]').forEach((row) => {
          row.addEventListener('click', () => {
            state.selectedOperationId = row.getAttribute('data-operation-id');
            loadSelectedOperation();
          });
        });
      }

      function renderDetail(operation) {
        const steps = operation.progress.steps.map((step) => (
          '<div class="detail-item">' +
            '<strong>' + escapeHtml(step.name) + '</strong><br />' +
            statusChip(step.status) +
            '<div class="uri" style="margin-top:6px">' +
              escapeHtml(step.startedAt ? formatDate(step.startedAt) : 'Not started') +
              (step.completedAt ? ' → ' + escapeHtml(formatDate(step.completedAt)) : '') +
            '</div>' +
          '</div>'
        )).join('');

        detail.innerHTML =
          '<div class="detail-item"><strong>Operation</strong><div class="mono">' + escapeHtml(operation.operation.id) + '</div></div>' +
          '<div class="detail-item"><strong>Status</strong><div style="margin-top:8px">' + statusChip(operation.operation.status) + '</div></div>' +
          '<div class="detail-item"><strong>Progress</strong><div>' + escapeHtml(operation.progress.completedSteps) + ' / ' + escapeHtml(operation.progress.totalSteps) + ' steps · ' + escapeHtml(operation.progress.percentage) + '%</div></div>' +
          '<div class="detail-item"><strong>Current Step</strong><div>' + escapeHtml(operation.currentStep || 'none') + '</div></div>' +
          '<div class="detail-item"><strong>Retryable</strong><div>' + escapeHtml(operation.retryable ? 'yes' : 'no') + '</div></div>' +
          '<div class="detail-item"><strong>Timings</strong><div class="uri">Created: ' + escapeHtml(formatDate(operation.timings.createdAt)) + '<br />Updated: ' + escapeHtml(formatDate(operation.timings.updatedAt)) + '</div></div>' +
          (operation.error ? '<div class="detail-item"><strong>Error</strong><div>' + escapeHtml(operation.error.message) + '</div></div>' : '') +
          (operation.result ? '<div class="detail-item"><strong>Result Preview</strong><pre style="margin:0; white-space:pre-wrap">' + escapeHtml(JSON.stringify(operation.result, null, 2)) + '</pre></div>' : '') +
          steps;
      }

      async function loadSelectedOperation() {
        if (!state.selectedOperationId) return;
        try {
          const operation = await fetchJson('/v1/operations/' + encodeURIComponent(state.selectedOperationId));
          renderDetail(operation);
        } catch (error) {
          detail.innerHTML = '<div class="empty">' + escapeHtml(error.message || 'Could not load operation detail') + '</div>';
        }
      }

      async function refresh() {
        try {
          const [overview, operations] = await Promise.all([
            fetchJson('/v1/admin/overview'),
            fetchJson('/v1/admin/operations?' + queryString()),
          ]);
          renderOverview(overview);
          renderSnapshotList(failures, overview.latestFailures, 'No recent failures.');
          renderSnapshotList(completed, overview.latestCompleted, 'No completed jobs yet.');
          renderOperations(operations.items);
          if (state.selectedOperationId) {
            await loadSelectedOperation();
          }
        } catch (error) {
          operationsBody.innerHTML = '<tr><td colspan="6"><div class="empty">' + escapeHtml(error.message || 'Dashboard refresh failed') + '</div></td></tr>';
        }
      }

      document.getElementById('refresh').addEventListener('click', refresh);
      [statusField, kindField, providerField, sourceTypeField].forEach((element) => {
        element.addEventListener('change', refresh);
      });

      refresh();
      state.timer = window.setInterval(refresh, 5000);
    </script>
  </body>
</html>`;
}
