// Scoped per-run analysis: queries only this run's own submissions (matched by the
// `loadtest-{runId}-user-*` userId prefix from run-load-test.mjs) rather than the global
// GET /api/v1/metrics window, so results from different worker-concurrency runs never mix.
//
// Usage: RUN_ID=run1 node load-tests/analyze-run.mjs
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env') });

const RUN_ID = process.env.RUN_ID;
if (!RUN_ID) {
  console.error('RUN_ID env var is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[Math.max(0, idx)].toFixed(1));
}

async function main() {
  const userPattern = `loadtest-${RUN_ID}-user-%`;

  const counts = await pool.query(
    `SELECT status, count(*) AS count FROM submissions WHERE user_id LIKE $1 GROUP BY status`,
    [userPattern],
  );

  const timings = await pool.query(
    `SELECT
       EXTRACT(EPOCH FROM (started_at - queued_at)) * 1000 AS queue_wait_ms,
       EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 AS processing_ms,
       EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000 AS end_to_end_ms
     FROM submissions WHERE user_id LIKE $1 AND status IN ('COMPLETED', 'FAILED')`,
    [userPattern],
  );

  const drain = await pool.query(
    `SELECT min(created_at) AS first_created, max(completed_at) AS last_completed
     FROM submissions WHERE user_id LIKE $1`,
    [userPattern],
  );

  const queueWait = timings.rows.map((r) => Number(r.queue_wait_ms)).filter((n) => !Number.isNaN(n));
  const processing = timings.rows.map((r) => Number(r.processing_ms)).filter((n) => !Number.isNaN(n));
  const endToEnd = timings.rows.map((r) => Number(r.end_to_end_ms)).filter((n) => !Number.isNaN(n));

  const statusCounts = Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.count)]));
  const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);
  const completed = statusCounts.COMPLETED ?? 0;
  const failed = statusCounts.FAILED ?? 0;

  const drainSeconds =
    drain.rows[0].first_created && drain.rows[0].last_completed
      ? (new Date(drain.rows[0].last_completed) - new Date(drain.rows[0].first_created)) / 1000
      : null;

  const report = {
    runId: RUN_ID,
    total,
    statusCounts,
    failureRate: total > 0 ? Number((failed / total).toFixed(4)) : null,
    drainSeconds: drainSeconds !== null ? Number(drainSeconds.toFixed(2)) : null,
    throughputPerSecond: drainSeconds > 0 ? Number((completed / drainSeconds).toFixed(2)) : null,
    queueWaitMs: { p50: percentile(queueWait, 50), p95: percentile(queueWait, 95) },
    processingMs: { p50: percentile(processing, 50), p95: percentile(processing, 95) },
    endToEndMs: { p50: percentile(endToEnd, 50), p95: percentile(endToEnd, 95) },
  };

  console.log(JSON.stringify(report, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
