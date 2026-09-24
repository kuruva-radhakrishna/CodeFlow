import { createRedisClient, dequeueSubmissionBlocking, enqueueSubmission } from '@codeflow/queue';
import { config } from './config.js';
import { pool } from './db.js';
import {
  claimSubmission,
  renewLease,
  getSubmissionForExecution,
  completeExecution,
  failSubmission,
  scheduleRetry,
} from './submissions.js';
import { submitToJudge0, normalizeJudge0Result, isRetryableJudge0Error, judge0FailureReason } from './judge0/index.js';
import { recoverStaleJobs } from './reaper.js';
import { promoteReadyRetries } from './retryScanner.js';
import { decideOutcome, MAX_RETRIES } from './retryPolicy.js';

const redis = createRedisClient(config.redisUrl);

let shuttingDown = false;
process.on('SIGINT', requestShutdown);
process.on('SIGTERM', requestShutdown);

function requestShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${config.workerId}] shutting down after the current job...`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Handles a Judge0-side failure (thrown error, or a successful-but-infra-failed response like
// Judge0's own internal error). Decides RETRY vs permanent FAIL using retryPolicy, and writes the
// outcome - ownership-guarded either way, so a worker that's lost the job can't clobber whoever
// has it now.
async function handleFailure(submissionId, retryCount, { retryable, failureReason, errorMessage }) {
  const outcome = decideOutcome({ retryable, retryCount });

  if (outcome.action === 'RETRY') {
    const scheduled = await scheduleRetry(submissionId, config.workerId, {
      failureReason,
      errorMessage,
      backoffSeconds: outcome.backoffSeconds,
    });
    if (scheduled) {
      console.warn(
        `[${config.workerId}] ${submissionId} RETRYING (attempt failed: ${failureReason}) - retry ${scheduled.retryCount}/${MAX_RETRIES} scheduled for ${scheduled.nextRetryAt.toISOString()}`,
      );
    } else {
      console.warn(`[${config.workerId}] ${submissionId} failed but retry scheduling was discarded - no longer owned`);
    }
    return;
  }

  const finalReason = outcome.failureReasonOverride ?? failureReason;
  const wrote = await failSubmission(submissionId, config.workerId, { failureReason: finalReason, errorMessage });
  console.error(`[${config.workerId}] ${submissionId} FAILED permanently: ${finalReason}${wrote ? '' : ' (discarded - no longer owned)'}`);
}

async function processSubmission(submissionId) {
  const claimed = await claimSubmission(submissionId, config.workerId, config.leaseDurationSeconds);
  if (!claimed) {
    console.warn(`[${config.workerId}] skipping ${submissionId}: not QUEUED (already claimed?)`);
    return;
  }

  const submission = await getSubmissionForExecution(submissionId);
  if (!submission) {
    await failSubmission(submissionId, config.workerId, {
      failureReason: 'ROW_MISSING',
      errorMessage: 'submission row disappeared after claim',
    });
    console.error(`[${config.workerId}] ${submissionId} FAILED: row missing after claim`);
    return;
  }

  console.log(`[${config.workerId}] running ${submissionId} on Judge0 (retry_count=${submission.retryCount})`);

  // Heartbeat: keep renewing the lease for as long as we're genuinely still working the job.
  // If we ever lose ownership mid-flight (reaper recovered it, another worker took over), we
  // can't cancel the in-flight Judge0 request, but we log it immediately so it's visible - the
  // eventual ownership-guarded write below will correctly no-op.
  const heartbeat = setInterval(async () => {
    const stillOwned = await renewLease(submissionId, config.workerId, config.leaseDurationSeconds);
    if (!stillOwned) {
      console.warn(`[${config.workerId}] LOST OWNERSHIP of ${submissionId} mid-execution (lease expired and was recovered elsewhere)`);
    }
  }, config.heartbeatIntervalSeconds * 1000);

  let result;
  try {
    const raw = await submitToJudge0({
      languageId: submission.languageId,
      sourceCode: submission.sourceCode,
      stdin: submission.stdin,
    });
    result = normalizeJudge0Result(raw);
  } catch (err) {
    clearInterval(heartbeat);
    await handleFailure(submissionId, submission.retryCount, {
      retryable: isRetryableJudge0Error(err),
      failureReason: judge0FailureReason(err),
      errorMessage: err.message,
    });
    return;
  }
  clearInterval(heartbeat);

  if (result.infraFailure) {
    // Judge0's own internal error (status.id=13) - a bad moment on Judge0's side, not our request
    // being malformed, so it's worth retrying just like a 5xx.
    await handleFailure(submissionId, submission.retryCount, {
      retryable: true,
      failureReason: 'JUDGE0_INTERNAL_ERROR',
      errorMessage: `Judge0 internal error: ${result.statusDescription ?? 'unknown'}`,
    });
    return;
  }

  const wrote = await completeExecution(submissionId, config.workerId, result);
  if (wrote) {
    console.log(`[${config.workerId}] ${submissionId} COMPLETED (${result.executionStatus})`);
  } else {
    console.warn(`[${config.workerId}] ${submissionId} finished Judge0 execution but result was DISCARDED - ownership was lost mid-flight (duplicate execution; the other worker's result stands)`);
  }
}

async function consumeLoop() {
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
}

async function reaperLoop() {
  while (!shuttingDown) {
    try {
      const recovered = await recoverStaleJobs();
      for (const id of recovered) {
        await enqueueSubmission(redis, id);
        console.warn(`[${config.workerId}] REAPER recovered stale job ${id} (lease expired) -> re-queued`);
      }
    } catch (err) {
      console.error(`[${config.workerId}] reaper error:`, err.message);
    }
    await sleep(config.reaperIntervalSeconds * 1000);
  }
}

async function retryLoop() {
  while (!shuttingDown) {
    try {
      const promoted = await promoteReadyRetries();
      for (const id of promoted) {
        await enqueueSubmission(redis, id);
        console.log(`[${config.workerId}] retry ready for ${id} -> re-queued`);
      }
    } catch (err) {
      console.error(`[${config.workerId}] retry scanner error:`, err.message);
    }
    await sleep(config.retryScanIntervalSeconds * 1000);
  }
}

async function main() {
  await Promise.all([consumeLoop(), reaperLoop(), retryLoop()]);
  await redis.quit();
  await pool.end();
  console.log(`[${config.workerId}] stopped`);
}

main();
