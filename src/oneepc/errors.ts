/** Typed error for any non-success OneEPC outcome. Branch on `code`; log `requestId`. */
export class OneEpcError extends Error {
  constructor(
    /** HTTP status; 0 for network/timeout failures. */
    readonly status: number,
    /** Envelope code (e.g. vin_not_found) or a client-side one: network_error, invalid_response, unexpected_response. */
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
    /** Seconds from the Retry-After header, when present (429). */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "OneEpcError";
  }

  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}
