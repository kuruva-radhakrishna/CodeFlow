// Retryable: Judge0 itself is having a bad moment, or we couldn't reach it. Worth trying again.
export class Judge0ServerError extends Error {
  constructor(status, body) {
    super(`Judge0 server error: ${status} ${body}`);
    this.name = 'Judge0ServerError';
  }
}

export class Judge0NetworkError extends Error {
  constructor(cause) {
    super(`Judge0 network error: ${cause.message}`);
    this.name = 'Judge0NetworkError';
    this.cause = cause;
  }
}

export class Judge0TimeoutError extends Error {
  constructor() {
    super('Judge0 did not finish within the poll budget');
    this.name = 'Judge0TimeoutError';
  }
}

// Not retryable: our request was malformed (bad language_id, encoding issue, etc). Judge0 will
// reject the identical retry the exact same way - retrying just burns quota for no benefit.
export class Judge0RequestError extends Error {
  constructor(status, body) {
    super(`Judge0 rejected the request: ${status} ${body}`);
    this.name = 'Judge0RequestError';
  }
}

export function isRetryableJudge0Error(err) {
  return (
    err instanceof Judge0ServerError ||
    err instanceof Judge0NetworkError ||
    err instanceof Judge0TimeoutError
  );
}

export function judge0FailureReason(err) {
  if (err instanceof Judge0ServerError) return 'JUDGE0_5XX';
  if (err instanceof Judge0NetworkError) return 'NETWORK_ERROR';
  if (err instanceof Judge0TimeoutError) return 'JUDGE0_TIMEOUT';
  if (err instanceof Judge0RequestError) return 'INVALID_REQUEST';
  return 'UNKNOWN_ERROR';
}
