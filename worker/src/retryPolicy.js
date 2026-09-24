export const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? 3);

// attempt 1 fails -> 1s, attempt 2 fails -> 2s, attempt 3 fails -> 4s (exponential, base 2).
// retryCount is "how many retries have already been consumed" (0 before the first retry).
export function backoffSecondsForRetry(retryCount) {
  return 2 ** retryCount;
}

// Given a classified failure and the submission's current retry_count, decide what happens next.
// Pure and deterministic - no I/O, no Judge0, no Postgres - so it's cheap to test exhaustively.
export function decideOutcome({ retryable, retryCount }) {
  if (!retryable) {
    return { action: 'FAIL' };
  }
  if (retryCount >= MAX_RETRIES) {
    return { action: 'FAIL', failureReasonOverride: 'MAX_RETRIES_EXCEEDED' };
  }
  return { action: 'RETRY', backoffSeconds: backoffSecondsForRetry(retryCount) };
}
