import { z } from 'zod';

const json = z.string().transform((value, context) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid JSON' });
    return z.NEVER;
  }
});
const sourceAuth = z
  .object({
    cookiesPath: z.string().min(1).optional(),
    cookiesFromBrowser: z.string().min(1).optional(),
  })
  .strict();
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  MEDIA_OWNER_TOKEN: z.string().min(32),
  MEDIA_PUBLIC_URL: z.url().default('http://localhost:4000'),
  MEDIA_HOST: z.string().default('0.0.0.0'),
  MEDIA_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MEDIA_WORK_ROOT: z.string().default('./.media'),
  MEDIA_WORKERS: z.coerce.number().int().min(1).max(16).default(2),
  MEDIA_CHUNK_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  MEDIA_MAX_DOWNLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024 * 1024),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_PROJECT_ID: z.string().optional(),
  GOOGLE_SPEECH_RECOGNIZER: z.string().optional(),
  MEDIA_OPENAI_MODEL: z.string().optional(),
  MEDIA_GEMINI_TRANSCRIPTION_MODEL: z.string().optional(),
  MEDIA_GEMINI_UNDERSTANDING_MODEL: z.string().optional(),
  MEDIA_GOOGLE_SPEECH_MODEL: z.string().optional(),
  MEDIA_TRANSLATION_MODEL: z.string().optional(),
  MEDIA_CODEX_HOME: z.string().min(1).optional(),
  MEDIA_CLAUDE_HOME: z.string().min(1).optional(),
  MEDIA_CODEX_PATH: z.string().min(1).optional(),
  MEDIA_CLAUDE_PATH: z.string().min(1).optional(),
  MEDIA_CODEX_MODEL: z.string().min(1).optional(),
  MEDIA_CLAUDE_MODEL: z.string().min(1).optional(),
  MEDIA_SUBSCRIPTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(90_000)
    .max(30 * 60_000)
    .default(10 * 60_000),
  TELEGRAM_PROXY_URL: z.url().optional(),
  TELEGRAM_PROXY_TOKEN: z.string().optional(),
  YT_DLP_ALLOWED_HOSTS: z.string().optional(),
  YT_DLP_COOKIES_PATH: z.string().optional(),
  YT_DLP_COOKIES_FROM_BROWSER: z.string().optional(),
  YT_DLP_AUTH_JSON: json.pipe(z.record(z.string(), sourceAuth)).optional(),
  YT_DLP_SITES_JSON: json
    .pipe(
      z.array(
        z
          .object({
            id: z.string().min(1),
            hosts: z.array(z.string().min(1)).min(1),
            extractors: z.array(z.string().min(1)).min(1),
            pathPattern: z.string().min(1).optional(),
          })
          .strict(),
      ),
    )
    .optional(),
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid server configuration: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  const url = new URL(result.data.MEDIA_PUBLIC_URL);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('MEDIA_PUBLIC_URL must be an origin without credentials');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('MEDIA_PUBLIC_URL must use HTTPS except on loopback');
  return { ...result.data, MEDIA_PUBLIC_URL: url.origin };
}
