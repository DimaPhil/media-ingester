import {
  jobSchema,
  type ErrorDetails,
  type JobError,
  type JobStage,
  type JobView,
  type MediaRequest,
  type NextStep,
} from '@media-ingest/contracts';
import { MediaError } from './errors.js';
import type { JobRecord } from './ports.js';

/** Stages a running attempt passes through; `queued` and the terminal stages follow the status. */
export type RunningStage = Exclude<JobStage, 'queued' | 'completed' | 'failed'>;

const MAX_DETAILS = 24;
const MAX_DETAIL_STRING = 200;
const detailKey = /^[A-Za-z][\w.]{0,63}$/;
// Defense in depth: a detail never carries an address, which could hold a token or private path.
const looksLikeUrl = /[a-z][a-z\d+.-]*:\/\//i;

/** Keeps flat primitive diagnostics only; drops URLs and truncates long strings. */
export function sanitizeDetails(details: Record<string, unknown>): ErrorDetails | undefined {
  const clean: ErrorDetails = {};
  let count = 0;
  for (const [key, value] of Object.entries(details)) {
    if (count >= MAX_DETAILS || !detailKey.test(key) || value === undefined) continue;
    if (typeof value === 'string') {
      if (looksLikeUrl.test(value)) continue;
      clean[key] = value.slice(0, MAX_DETAIL_STRING);
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      clean[key] = value;
    } else if (typeof value === 'boolean' || value === null) clean[key] = value;
    else continue;
    count++;
  }
  return count ? clean : undefined;
}

/**
 * Durable failure for a job: a `MediaError` keeps its code and gains the worker's context; any
 * other error stays `processing_failed` and records only its class name.
 */
export function describeFailure(error: unknown, context: Record<string, unknown>): JobError {
  if (error instanceof MediaError) {
    const details = sanitizeDetails({ ...context, ...error.details });
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(details ? { details } : {}),
    };
  }
  const errorName =
    error instanceof Error ? error.name : typeof error === 'object' ? 'UnknownError' : typeof error;
  const details = sanitizeDetails({ ...context, errorName });
  return {
    code: 'processing_failed',
    message: 'Media processing failed; check server logs',
    retryable: true,
    ...(details ? { details } : {}),
  };
}

/** Suggested seconds between `get` calls for an active job. */
const pollAfterSeconds: Record<Exclude<JobStage, 'completed' | 'failed'>, number> = {
  queued: 5,
  resolving: 10,
  downloading: 15,
  inspecting: 10,
  planning: 15,
  processing: 30,
  synthesizing: 20,
  translating: 15,
};

/** Codes that point at the selected model provider rather than the source or the service. */
function providerFailure(error: JobError): boolean {
  const { code, details } = error;
  return (
    code.startsWith('provider_') ||
    code.startsWith('subscription_') ||
    code === 'invalid_provider_output' ||
    (code === 'processing_failed' &&
      ['processing', 'synthesizing', 'translating'].includes(String(details?.stage)))
  );
}
const sourceFailures = new Set([
  'invalid_media',
  'invalid_source',
  'unsupported_source',
  'media_too_large',
  'payload_too_large',
]);

function stageOf(job: JobView): JobStage {
  if (job.status !== 'running') return job.status;
  return job.stage && !['queued', 'completed', 'failed'].includes(job.stage)
    ? job.stage
    : job.totalChunks > 0
      ? 'processing'
      : 'resolving';
}

function activeSteps(job: JobView, stage: JobStage): NextStep[] {
  if (stage === 'completed' || stage === 'failed') return [];
  const progress =
    stage === 'processing' && job.totalChunks
      ? ` (${job.completedChunks}/${job.totalChunks} chunks done)`
      : '';
  return [
    {
      operation: 'get',
      input: { id: job.id },
      reason: `Job is ${stage}${progress}; poll until it completes or fails`,
      pollAfterSeconds: pollAfterSeconds[stage],
    },
  ];
}

function failedSteps(
  job: JobView,
  error: JobError,
  alternatives: readonly MediaRequest['provider'][],
): NextStep[] {
  const steps: NextStep[] = [];
  if (error.retryable)
    steps.push({
      operation: 'retry',
      input: { id: job.id },
      reason: job.completedChunks
        ? `Failure may be transient; retry reuses ${job.completedChunks} completed chunks`
        : 'Failure may be transient; retry the job',
    });
  const alternative = alternatives.find((provider) => provider !== job.request.provider);
  if (providerFailure(error) && alternative) {
    const { model: _model, ...request } = job.request;
    steps.push({
      operation: 'submit',
      input: { request: { ...request, provider: alternative } },
      reason: `Process with ${alternative} instead; uses that provider's quota`,
    });
  }
  if (!error.retryable && error.code === 'source_changed')
    steps.push({
      operation: 'submit',
      input: { request: job.request },
      reason: 'Source changed since the saved chunks; submit a new job',
    });
  else if (!error.retryable && sourceFailures.has(error.code))
    steps.push({
      operation: 'resolve',
      input: { source: job.request.source },
      reason: 'Check or replace the input; the same source fails the same way',
    });
  return steps;
}

/**
 * Public job view: strips persistence fields, derives the stage and attaches suggested next
 * calls. Completed jobs carry none; their result is self-contained.
 */
export function jobView(
  job: JobRecord | JobView,
  alternatives: readonly MediaRequest['provider'][] = [],
): JobView {
  const view = jobSchema.parse(job);
  const stage = stageOf(view);
  delete view.nextSteps;
  const steps = activeSteps(view, stage);
  if (view.error) {
    delete view.error.nextSteps;
    if (view.status === 'failed') {
      const next = failedSteps(view, view.error, alternatives);
      if (next.length) view.error.nextSteps = next;
    }
  }
  return { ...view, stage, ...(steps.length ? { nextSteps: steps } : {}) };
}
