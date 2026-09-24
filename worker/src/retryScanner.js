import { pool } from './db.js';

// Distinct from the reaper (worker/src/reaper.js): the reaper recovers RUNNING jobs whose lease
// expired (a worker presumably died); this promotes RETRYING jobs whose backoff has elapsed back
// to QUEUED so a worker's normal claim path picks them up like any other queued job. The two
// operate on disjoint status values (RUNNING vs RETRYING) and never contend with each other.
export async function promoteReadyRetries() {
  const result = await pool.query(
    `UPDATE submissions
     SET status = 'QUEUED', worker_id = NULL, lease_until = NULL, next_retry_at = NULL
     WHERE status = 'RETRYING' AND next_retry_at <= now()
     RETURNING id`,
  );
  return result.rows.map((row) => row.id);
}
