import { pool } from './db.js';

// Recovers RUNNING jobs whose lease has expired - the owning worker either crashed or lost
// contact, and simply stopped renewing the lease. No worker needs to notice its own death; any
// worker's reaper (including, harmlessly, the original claimer's own) can recover any stale job.
// Runs as a plain UPDATE, so if two reapers race on the same row, only one gets it back.
export async function recoverStaleJobs() {
  const result = await pool.query(
    `UPDATE submissions
     SET status = 'QUEUED', worker_id = NULL, lease_until = NULL
     WHERE status = 'RUNNING' AND lease_until < now()
     RETURNING id`,
  );
  return result.rows.map((row) => row.id);
}
