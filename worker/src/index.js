import { createRedisClient, dequeueSubmissionBlocking, enqueueSubmission } from '@codeflow/queue';
import { config } from './config.js';
import { pool } from './db.js';
import {
  claimSubmission,
  renewLease,
  getSubmissionForExecution,
  completeExecution,
  failSubmission,
} from './submissions.js';
import { submitToJudge0, normalizeJudge0Result } from './judge0/index.js';
import { recoverStaleJobs } from './reaper.js';

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

async function processSubmission(submissionId) {
  const claimed = await claimSubmission(submissionId, config.workerId, config.leaseDurationSeconds);
  if (!claimed) {
    console.warn(`[${config.workerId}] skipping ${submissionId}: not QUEUED (already claimed?)`);
    return;
  }

  const submission = await getSubmissionForExecution(submissionId);
  if (!submission) {
    await failSubmission(submissionId, config.workerId, 'submission row disappeared after claim');
    console.error(`[${config.workerId}] ${submissionId} FAILED: row missing after claim`);
    return;
  }

  console.log(`[${config.workerId}] running ${submissionId} on Judge0`);

  // Heartbeat: keep renewing the lease for as long as we're genuinely still working the job.
  // If we ever lose ownership mid-flight (reaper recovered it, another worker took over), we
  // can't cancel the in-flight Judge0 request, but we log it immediately so it's visible - the
  // eventual ownership-guarded write in completeExecution/failSubmission will correctly no-op.
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
    const wrote = await failSubmission(submissionId, config.workerId, err.message);
    console.error(`[${config.workerId}] ${submissionId} FAILED: ${err.message}${wrote ? '' : ' (discarded - no longer owned)'}`);
    return;
  }
  clearInterval(heartbeat);

  if (result.infraFailure) {
    const wrote = await failSubmission(submissionId, config.workerId, `Judge0 internal error: ${result.statusDescription ?? 'unknown'}`);
    console.error(`[${config.workerId}] ${submissionId} FAILED: Judge0 internal error${wrote ? '' : ' (discarded - no longer owned)'}`);
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

async function main() {
  await Promise.all([consumeLoop(), reaperLoop()]);
  await redis.quit();
  await pool.end();
  console.log(`[${config.workerId}] stopped`);
}

main();
