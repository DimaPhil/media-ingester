import { serve } from '@hono/node-server';
import postgres from 'postgres';
import { MediaSdk } from '@media-ingest/sdk';
import {
  PostgresJobRepository,
  PostgresJobRetention,
  PostgresAuthStore,
  NodeMedia,
  NodeSources,
  NodeProviders,
} from '@media-ingest/adapters';
import { createApplication } from './application.js';
import { drainAll, startMaintenance } from './background.js';
import { loadConfig } from './config.js';
import { createUploadStorage } from './upload-storage.js';
import { jobFailureLog } from './logging.js';

const config = loadConfig();
const sql = postgres(config.DATABASE_URL, { max: 10 });
// Migrations are an explicit deployment step, never a side effect of a request or startup.
await sql`SELECT id FROM media_v1.jobs LIMIT 0`;
const [migration] = await sql`SELECT version FROM media_v1.migrations WHERE version = 3`;
if (!migration) throw new Error('Apply migration 003 before starting the API');
const credentials = config.GOOGLE_SERVICE_ACCOUNT_JSON
  ? (JSON.parse(config.GOOGLE_SERVICE_ACCOUNT_JSON) as Record<string, unknown>)
  : undefined;
const { files, retention } = createUploadStorage(sql, config.MEDIA_WORK_ROOT);
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
  geminiYoutubeUrls: config.MEDIA_GEMINI_YOUTUBE_URLS,
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
  repository: new PostgresJobRepository(sql, undefined, retention),
  sources,
  media,
  provider,
  chunkConcurrency: config.MEDIA_CHUNK_CONCURRENCY,
  onCleanupError: () => console.error('Workspace cleanup failed'),
  onProcessingError: (jobId, error, failure) => console.error(jobFailureLog(jobId, error, failure)),
});
const authStore = new PostgresAuthStore(sql);
const UPLOAD_BATCH = 32;
const JOB_EXPIRY_BATCH = 100;
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
const jobRetention = new PostgresJobRetention(sql, retention);
const maintenance = startMaintenance({
  cleanUploads: drainAll(() => retention.drain(UPLOAD_BATCH), UPLOAD_BATCH),
  expireJobs: drainAll(() => jobRetention.drain(), JOB_EXPIRY_BATCH),
  pruneAuth: () => authStore.prune(),
  intervalMs: config.MEDIA_MAINTENANCE_INTERVAL_MS,
  onError: (task) =>
    console.error(
      {
        uploads: 'Completed upload cleanup failed; will retry',
        jobs: 'Expired job cleanup failed; will retry',
        auth: 'Auth expiry cleanup failed',
      }[task],
    ),
});
const abort = new AbortController();
// Idle workers issue no queries until a submission/retry wakes them or the fallback poll fires,
// so a scale-to-zero database (Neon suspends after 5 idle minutes) can suspend.
const workers = sdk.runWorkers({
  workers: config.MEDIA_WORKERS,
  idlePollMs: config.MEDIA_WORKER_IDLE_POLL_MS,
  signal: abort.signal,
  onIdle: () => maintenance.workersIdle(),
  onError: () => console.error('Worker failed; durable job remains recoverable'),
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
  const deadline = setTimeout(() => process.exit(1), 30000);
  deadline.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await workers.catch(() => {});
  await maintenance.stop();
  await application.close();
  await sql.end();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
