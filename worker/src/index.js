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
import { createMetrics, publishSnapshot } from './metrics.js';
import { startHealthServer } from './healthServer.js';

// Shared connection for non-blocking commands (enqueue from the reaper/retry loops). Each
// concurrency lane gets its OWN connection for dequeuing - BRPOP blocks the connection it's
// issued on until a job arrives, so lanes sharing one connection would serialize on it, defeating
// the whole point of concurrency.
const redis = createRedisClient(config.redisUrl);
const metrics = createMetrics();

let shuttingDown = false;
process.on('SIGINT', requestShutdown);
process.on('SIGTERM', requestShutdown);

function requestShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${config.workerId}] shutting down after in-flight jobs finish...`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Handles a Judge0-side failure (thrown error, or a successful-but-infra-failed response like
// Judge0's own internal error). Decides RETRY vs permanent FAIL using retryPolicy, and writes the
// outcome - ownership-guarded either way, so a worker that's lost the job can't clobber whoever
// has it now.
async function handleFailure(logTag, submissionId, retryCount, { retryable, failureReason, errorMessage }) {
  const outcome = decideOutcome({ retryable, retryCount });

  if (outcome.action === 'RETRY') {
    const scheduled = await scheduleRetry(submissionId, config.workerId, {
      failureReason,
      errorMessage,
      backoffSeconds: outcome.backoffSeconds,
    });
    if (scheduled) {
      metrics.increment('retried');
      console.warn(
        `${logTag} ${submissionId} RETRYING (attempt failed: ${failureReason}) - retry ${scheduled.retryCount}/${MAX_RETRIES} scheduled for ${scheduled.nextRetryAt.toISOString()}`,
      );
    } else {
      metrics.increment('discarded');
      console.warn(`${logTag} ${submissionId} failed but retry scheduling was discarded - no longer owned`);
    }
    return;
  }

  const finalReason = outcome.failureReasonOverride ?? failureReason;
  const wrote = await failSubmission(submissionId, config.workerId, { failureReason: finalReason, errorMessage });
  metrics.increment(wrote ? 'failed' : 'discarded');
  console.error(`${logTag} ${submissionId} FAILED permanently: ${finalReason}${wrote ? '' : ' (discarded - no longer owned)'}`);
}

async function processSubmission(submissionId, logTag) {
  const claimed = await claimSubmission(submissionId, config.workerId, config.leaseDurationSeconds);
  if (!claimed) {
    console.warn(`${logTag} skipping ${submissionId}: not QUEUED (already claimed?)`);
    return;
  }
  metrics.increment('claimed');

  const submission = await getSubmissionForExecution(submissionId);
  if (!submission) {
    await failSubmission(submissionId, config.workerId, {
      failureReason: 'ROW_MISSING',
      errorMessage: 'submission row disappeared after claim',
    });
    metrics.increment('failed');
    console.error(`${logTag} ${submissionId} FAILED: row missing after claim`);
    return;
  }

  console.log(`${logTag} running ${submissionId} on Judge0 (retry_count=${submission.retryCount})`);

  // Heartbeat: keep renewing the lease for as long as we're genuinely still working the job.
  // If we ever lose ownership mid-flight (reaper recovered it, another worker took over), we
  // can't cancel the in-flight Judge0 request, but we log it immediately so it's visible - the
  // eventual ownership-guarded write below will correctly no-op.
  const heartbeat = setInterval(async () => {
    const stillOwned = await renewLease(submissionId, config.workerId, config.leaseDurationSeconds);
    if (!stillOwned) {
      console.warn(`${logTag} LOST OWNERSHIP of ${submissionId} mid-execution (lease expired and was recovered elsewhere)`);
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
    await handleFailure(logTag, submissionId, submission.retryCount, {
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
    await handleFailure(logTag, submissionId, submission.retryCount, {
      retryable: true,
      failureReason: 'JUDGE0_INTERNAL_ERROR',
      errorMessage: `Judge0 internal error: ${result.statusDescription ?? 'unknown'}`,
    });
    return;
  }

  const wrote = await completeExecution(submissionId, config.workerId, result);
  metrics.increment(wrote ? 'completed' : 'discarded');
  if (wrote) {
    console.log(`${logTag} ${submissionId} COMPLETED (${result.executionStatus})`);
  } else {
    console.warn(`${logTag} ${submissionId} finished Judge0 execution but result was DISCARDED - ownership was lost mid-flight (duplicate execution; the other worker's result stands)`);
  }
}

// One lane = one independent claim/execute/complete loop with its own dedicated Redis connection.
// N lanes running concurrently is what gives a single worker process bounded concurrency;
// worker_id (DB ownership identity) is shared across all of a process's lanes on purpose - the
// atomic claim already guarantees only one lane anywhere ends up owning a given row, so lanes
// don't need their own identity, just their own connection.
async function runLane(laneId) {
  const logTag = `[${config.workerId}:lane${laneId}]`;
  const laneRedis = createRedisClient(config.redisUrl);
  console.log(`${logTag} started`);

  while (!shuttingDown) {
    let submissionId;
    try {
      submissionId = await dequeueSubmissionBlocking(laneRedis, config.pollTimeoutSeconds);
    } catch (err) {
      console.error(`${logTag} dequeue error:`, err.message);
      continue;
    }

    if (!submissionId) continue; // poll timeout - loop back around to re-check shuttingDown

    try {
      await processSubmission(submissionId, logTag);
    } catch (err) {
      console.error(`${logTag} failed processing ${submissionId}:`, err);
    }
  }

  await laneRedis.quit();
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

async function metricsLoop() {
  while (!shuttingDown) {
    await sleep(config.metricsLogIntervalSeconds * 1000);
    const snapshot = metrics.snapshot();
    console.log(`[${config.workerId}] metrics: ${JSON.stringify(snapshot)}`);
    try {
      // TTL is a few publish intervals wide so normal jitter never expires a live worker's entry,
      // while a crashed worker's entry still self-cleans within a bounded window - no separate
      // cleanup process needed, same self-expiring pattern as the submission lease.
      await publishSnapshot(redis, config.workerId, snapshot, config.metricsLogIntervalSeconds * 3);
    } catch (err) {
      console.error(`[${config.workerId}] failed to publish metrics snapshot:`, err.message);
    }
  }
}

async function main() {
  console.log(`[${config.workerId}] starting ${config.workerConcurrency} lane(s)`);

  if (config.port) {
    startHealthServer(config.port);
    console.log(`[${config.workerId}] health server listening on :${config.port} (for platforms that require a bound port)`);
  }

  const lanes = Array.from({ length: config.workerConcurrency }, (_, i) => runLane(i));

  await Promise.all([...lanes, reaperLoop(), retryLoop(), metricsLoop()]);

  await redis.quit();
  await pool.end();
  console.log(`[${config.workerId}] stopped. final metrics: ${JSON.stringify(metrics.snapshot())}`);
}

main();
