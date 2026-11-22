import { describe, expect, it } from 'vitest';
import { MediaError } from '@media-ingest/sdk';
import { jobFailureLog } from '../src/logging.js';

describe('job failure log', () => {
  it('writes one JSON line with the recorded failure and no foreign error text', () => {
    const failure = {
      code: 'provider_invalid_output',
      message: 'google-gemini returned unusable output: response is not valid JSON',
      retryable: true,
      details: {
        stage: 'processing',
        attempt: 2,
        provider: 'google-gemini',
        model: 'gemini-2.5-flash',
        chunkIndex: 7,
        chunkStartMs: 4_200_000,
        chunkEndMs: 4_800_000,
        finishReason: 'STOP',
        outputTokens: 5012,
        parseErrorPosition: 11848,
        errorName: 'SyntaxError',
      },
    };
    const error = new MediaError(failure.code, failure.message, true, failure.details);
    const line = jobFailureLog('job-1', error, failure);
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      level: 'error',
      event: 'job_failed',
      jobId: 'job-1',
      code: 'provider_invalid_output',
      retryable: true,
      message: failure.message,
      ...failure.details,
    });
    const unknown = JSON.parse(
      jobFailureLog(
        'job-2',
        new SyntaxError('Unexpected token in {"text":"private transcript"} at https://x.test?k=1'),
        { code: 'processing_failed', message: 'Media processing failed', retryable: true },
      ),
    );
    expect(unknown).toEqual({
      level: 'error',
      event: 'job_failed',
      jobId: 'job-2',
      code: 'processing_failed',
      retryable: true,
      errorName: 'SyntaxError',
    });
  });
});
