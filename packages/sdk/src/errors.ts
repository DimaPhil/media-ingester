export class MediaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
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
