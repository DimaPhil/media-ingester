import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import postgres from 'postgres';
import { MediaSdk } from '@media-ingest/sdk';
import {
  PostgresJobRepository,
  PostgresAuthStore,
  NodeFiles,
  NodeMedia,
  NodeSources,
  NodeProviders,
} from '@media-ingest/adapters';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const sql = postgres(config.DATABASE_URL, { max: 10 });
// Migrations are an explicit deployment step, never a side effect of a request or startup.
await sql`SELECT id FROM media_v1.jobs LIMIT 0`;
const credentials = config.GOOGLE_SERVICE_ACCOUNT_JSON
  ? (JSON.parse(config.GOOGLE_SERVICE_ACCOUNT_JSON) as Record<string, unknown>)
  : undefined;
const files = new NodeFiles({ workRoot: config.MEDIA_WORK_ROOT });
const media = new NodeMedia({ files });
const sources = new NodeSources({
  files,
  maxDownloadBytes: config.MEDIA_MAX_DOWNLOAD_BYTES,
  googleCredentials: credentials,
  telegramBaseUrl: config.TELEGRAM_PROXY_URL,
  telegramToken: config.TELEGRAM_PROXY_TOKEN,
  ytDlpAllowedHosts: config.YT_DLP_ALLOWED_HOSTS?.split(',')
    .map((host) => host.trim())
    .filter(Boolean),
  ytDlpCookiesPath: config.YT_DLP_COOKIES_PATH,
  ytDlpCookiesFromBrowser: config.YT_DLP_COOKIES_FROM_BROWSER,
  ytDlpAuth: config.YT_DLP_AUTH_JSON,
  ytDlpSites: config.YT_DLP_SITES_JSON,
});
const provider = new NodeProviders({
  openaiApiKey: config.OPENAI_API_KEY,
  geminiApiKey: config.GEMINI_API_KEY,
  googleCredentials: credentials,
  googleProject: config.GOOGLE_PROJECT_ID,
  googleRecognizer: config.GOOGLE_SPEECH_RECOGNIZER,
  subscription: config.MEDIA_CODEX_HOME
    ? {
        codexHome: config.MEDIA_CODEX_HOME,
        claudeHome: config.MEDIA_CLAUDE_HOME,
        codexPath: config.MEDIA_CODEX_PATH,
        claudePath: config.MEDIA_CLAUDE_PATH,
        timeoutMs: config.MEDIA_SUBSCRIPTION_TIMEOUT_MS,
      }
    : undefined,
  models: {
    openai: config.MEDIA_OPENAI_MODEL,
    geminiTranscription: config.MEDIA_GEMINI_TRANSCRIPTION_MODEL,
    geminiUnderstanding: config.MEDIA_GEMINI_UNDERSTANDING_MODEL,
    googleSpeech: config.MEDIA_GOOGLE_SPEECH_MODEL,
    translation: config.MEDIA_TRANSLATION_MODEL,
    codexUnderstanding: config.MEDIA_CODEX_MODEL,
    claudeUnderstanding: config.MEDIA_CLAUDE_MODEL,
  },
});
const sdk = new MediaSdk({
  repository: new PostgresJobRepository(sql),
  sources,
  media,
  provider,
  chunkConcurrency: config.MEDIA_CHUNK_CONCURRENCY,
  onCleanupError: () => console.error('Workspace cleanup failed'),
  onProcessingError: (jobId, error) =>
    console.error(
      'Job processing failed',
      jobId,
      error instanceof Error &&
        /^(?:Provider|Source service) returned HTTP \d{3}$/.test(error.message)
        ? error.message
        : error instanceof Error
          ? error.name
          : 'UnknownError',
    ),
});
const authStore = new PostgresAuthStore(sql);
const application = createApplication({
  sdk,
  sources,
  media,
  files,
  authStore,
  publicUrl: config.MEDIA_PUBLIC_URL,
  ownerToken: config.MEDIA_OWNER_TOKEN,
  logger: (error) =>
    console.error('Request failed', error instanceof Error ? error.name : 'UnknownError'),
});
const pruneTimer = setInterval(
  () => {
    void authStore.prune().catch(() => console.error('Auth expiry cleanup failed'));
  },
  60 * 60 * 1000,
);
pruneTimer.unref();
const abort = new AbortController();
const workers = Array.from({ length: config.MEDIA_WORKERS }, async () => {
  while (!abort.signal.aborted) {
    try {
      if (!(await sdk.runNext(abort.signal)))
        await delay(1000, undefined, { signal: abort.signal });
    } catch {
      if (!abort.signal.aborted) {
        console.error('Worker failed; durable job remains recoverable');
        await delay(1000, undefined, { signal: abort.signal }).catch(() => {});
      }
    }
  }
});
const server = serve(
  { fetch: application.app.fetch, hostname: config.MEDIA_HOST, port: config.MEDIA_PORT },
  () => console.log(`Media API listening on port ${config.MEDIA_PORT}`),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  abort.abort();
  clearInterval(pruneTimer);
  const deadline = setTimeout(() => process.exit(1), 30000);
  deadline.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.allSettled(workers);
  await application.close();
  await sql.end();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
