import { createRedisClient, dequeueSubmissionBlocking } from '@codeflow/queue';
import { config } from './config.js';
import { pool } from './db.js';
import { claimSubmission, getSubmissionForExecution, completeExecution, failSubmission } from './submissions.js';
import { submitToJudge0, normalizeJudge0Result } from './judge0/index.js';

const redis = createRedisClient(config.redisUrl);

let shuttingDown = false;
process.on('SIGINT', requestShutdown);
process.on('SIGTERM', requestShutdown);

function requestShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${config.workerId}] shutting down after the current job...`);
}

async function processSubmission(submissionId) {
  const claimed = await claimSubmission(submissionId, config.workerId);
  if (!claimed) {
    console.warn(`[${config.workerId}] skipping ${submissionId}: not QUEUED (already claimed?)`);
    return;
  }

  const submission = await getSubmissionForExecution(submissionId);
  if (!submission) {
    await failSubmission(submissionId, 'submission row disappeared after claim');
    console.error(`[${config.workerId}] ${submissionId} FAILED: row missing after claim`);
    return;
  }

  console.log(`[${config.workerId}] running ${submissionId} on Judge0`);

  let result;
  try {
    const raw = await submitToJudge0({
      languageId: submission.languageId,
      sourceCode: submission.sourceCode,
      stdin: submission.stdin,
    });
    result = normalizeJudge0Result(raw);
  } catch (err) {
    await failSubmission(submissionId, err.message);
    console.error(`[${config.workerId}] ${submissionId} FAILED: ${err.message}`);
    return;
  }

  if (result.infraFailure) {
    await failSubmission(submissionId, `Judge0 internal error: ${result.statusDescription ?? 'unknown'}`);
    console.error(`[${config.workerId}] ${submissionId} FAILED: Judge0 internal error`);
    return;
  }

  await completeExecution(submissionId, result);
  console.log(`[${config.workerId}] ${submissionId} COMPLETED (${result.executionStatus})`);
}

async function main() {
  console.log(`[${config.workerId}] started, watching the submission queue`);

  while (!shuttingDown) {
    let submissionId;
    try {
      submissionId = await dequeueSubmissionBlocking(redis, config.pollTimeoutSeconds);
    } catch (err) {
      console.error(`[${config.workerId}] dequeue error:`, err.message);
      continue;
    }

    if (!submissionId) continue; // poll timeout - loop back around to re-check shuttingDown

    try {
      await processSubmission(submissionId);
    } catch (err) {
      console.error(`[${config.workerId}] failed processing ${submissionId}:`, err);
    }
  }

  await redis.quit();
  await pool.end();
  console.log(`[${config.workerId}] stopped`);
}

main();
