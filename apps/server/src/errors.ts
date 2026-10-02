export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503 = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * The external write may or may not have happened (timeout, 5xx, crashed mid-flight).
 * ActionService.decide() maps this to the `outcome_unknown` proposal status: no retries,
 * the agent reports the ambiguity and asks the user to check the provider.
 */
export class OutcomeUnknownError extends Error {
  readonly code = "outcome_unknown";
  constructor(message: string) {
    super(message);
    this.name = "OutcomeUnknownError";
  }
}
