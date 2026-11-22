import type { ErrorDetails } from '@media-ingest/contracts';

export class MediaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    /** Flat, public diagnostic context. Never put provider bodies, tokens or private URLs here. */
    public readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}
export class LeaseLostError extends MediaError {
  constructor() {
    super('lease_lost', 'The worker lease expired or was replaced', true);
  }
}
