// The queue carries only the submission id. PostgreSQL is the durable source of truth for
// everything else (source code, stdin, results) - Redis is just the work-distribution mechanism.
export const SUBMISSION_QUEUE_KEY = 'codeflow:submissions:queue';

export async function enqueueSubmission(redis, submissionId) {
  await redis.lpush(SUBMISSION_QUEUE_KEY, JSON.stringify({ submissionId }));
}

// Blocks until a job is available or `timeoutSeconds` elapses (returns null on timeout,
// so the worker can periodically check its own shutdown flag instead of blocking forever).
export async function dequeueSubmissionBlocking(redis, timeoutSeconds) {
  const result = await redis.brpop(SUBMISSION_QUEUE_KEY, timeoutSeconds);
  if (!result) return null;
  const [, payload] = result;
  const { submissionId } = JSON.parse(payload);
  return submissionId;
}

export async function queueDepth(redis) {
  return redis.llen(SUBMISSION_QUEUE_KEY);
}
