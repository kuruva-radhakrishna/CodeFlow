import { createRedisClient, dequeueSubmissionBlocking } from '@codeflow/queue';
import { config } from './config.js';
import { pool } from './db.js';
import { claimSubmission, markCompletedStub } from './submissions.js';

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

  console.log(`[${config.workerId}] running ${submissionId}`);
  await markCompletedStub(submissionId, config.workerId);
  console.log(`[${config.workerId}] completed ${submissionId}`);
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
