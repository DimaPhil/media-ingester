import type { JobError } from '@media-ingest/contracts';
import { MediaError } from '@media-ingest/sdk';

/**
 * One JSON line per failed attempt. `failure` is the recorded public error: code, retryable and
 * sanitized details (stage, attempt, provider, model, chunk range, finish reason, HTTP status,
 * token usage, parse position). Only `MediaError` messages, which this service writes, are
 * included; other errors contribute their class name. No content, tokens or source URLs.
 */
export function jobFailureLog(jobId: string, error: unknown, failure: JobError): string {
  return JSON.stringify({
    level: 'error',
    event: 'job_failed',
    jobId,
    code: failure.code,
    retryable: failure.retryable,
    errorName: error instanceof Error ? error.name : 'UnknownError',
    ...(error instanceof MediaError ? { message: error.message } : {}),
    ...failure.details,
  });
}
