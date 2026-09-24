import { queueDepth } from '@codeflow/queue';
import { pool } from '../db/pool.js';
import { redis } from '../queue/client.js';
import { RATE_LIMITED_TOTAL_KEY } from './rateLimiter.js';

const WORKER_METRICS_KEY_PREFIX = 'codeflow:worker-metrics:';
const RECENT_WINDOW = "created_at > now() - interval '24 hours'";

async function submissionCountsByStatus() {
  const r = await pool.query('SELECT status, count(*) AS count FROM submissions GROUP BY status');
  return Object.fromEntries(r.rows.map((row) => [row.status, Number(row.count)]));
}

// Answers "is the system slow because jobs sit in the queue, or because Judge0 itself is slow?"
// by breaking end-to-end latency into its two components separately, for COMPLETED submissions in
// the last 24h. Note: for a submission that went through retries, queue_wait/worker_processing
// only reflect the LAST attempt (started_at is overwritten on each reclaim) - end_to_end still
// correctly captures the full user-facing latency including retry/backoff time either way. A
// known simplification, not tracked more precisely to avoid adding columns for a metric this
// project-scale doesn't yet need broken down per-attempt.
async function latencyPercentiles() {
  const r = await pool.query(`
    SELECT
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (started_at - queued_at)) * 1000)   AS queue_wait_p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (started_at - queued_at)) * 1000)   AS queue_wait_p95,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000) AS worker_processing_p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000) AS worker_processing_p95,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000) AS end_to_end_p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000) AS end_to_end_p95,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000) AS end_to_end_p99,
      count(*) AS sample_size
    FROM submissions
    WHERE status = 'COMPLETED' AND ${RECENT_WINDOW}
  `);
  const row = r.rows[0];
  const ms = (v) => (v === null ? null : Number(Number(v).toFixed(1)));
  return {
    sampleSize: Number(row.sample_size),
    queueWaitMs: { p50: ms(row.queue_wait_p50), p95: ms(row.queue_wait_p95) },
    workerProcessingMs: { p50: ms(row.worker_processing_p50), p95: ms(row.worker_processing_p95) },
    endToEndMs: { p50: ms(row.end_to_end_p50), p95: ms(row.end_to_end_p95), p99: ms(row.end_to_end_p99) },
  };
}

async function executionOutcomeBreakdown() {
  const accepted = await pool.query(
    `SELECT execution_status, count(*) AS count FROM submissions
     WHERE status = 'COMPLETED' AND ${RECENT_WINDOW} GROUP BY execution_status`,
  );
  const failed = await pool.query(
    `SELECT failure_reason, count(*) AS count FROM submissions
     WHERE status = 'FAILED' AND ${RECENT_WINDOW} GROUP BY failure_reason`,
  );
  return {
    byExecutionStatus: Object.fromEntries(accepted.rows.map((r) => [r.execution_status ?? 'unknown', Number(r.count)])),
    byFailureReason: Object.fromEntries(failed.rows.map((r) => [r.failure_reason ?? 'unknown', Number(r.count)])),
  };
}

// Reads whichever workers currently have a live (unexpired) snapshot in Redis. KEYS is fine at
// this project's scale (a handful of worker processes); SCAN would be the production-safe
// equivalent for a keyspace large enough for KEYS to actually block the server.
async function activeWorkers() {
  const keys = await redis.keys(`${WORKER_METRICS_KEY_PREFIX}*`);
  const workers = await Promise.all(
    keys.map(async (key) => {
      const fields = await redis.hgetall(key);
      return {
        ...fields,
        claimed: Number(fields.claimed ?? 0),
        completed: Number(fields.completed ?? 0),
        failed: Number(fields.failed ?? 0),
        retried: Number(fields.retried ?? 0),
        discarded: Number(fields.discarded ?? 0),
      };
    }),
  );
  return workers;
}

export async function getMetricsSnapshot() {
  const [statusCounts, latency, outcomes, depth, rateLimitedTotal, workers] = await Promise.all([
    submissionCountsByStatus(),
    latencyPercentiles(),
    executionOutcomeBreakdown(),
    queueDepth(redis),
    redis.get(RATE_LIMITED_TOTAL_KEY),
    activeWorkers(),
  ]);

  return {
    submissions: {
      byStatus: statusCounts,
      total: Object.values(statusCounts).reduce((sum, n) => sum + n, 0),
      rateLimitedTotal: Number(rateLimitedTotal ?? 0),
    },
    queue: { depth },
    latency,
    executionOutcomes: outcomes,
    workers: { active: workers.length, detail: workers },
    generatedAt: new Date().toISOString(),
  };
}
