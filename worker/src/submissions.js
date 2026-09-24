import { pool } from './db.js';

// Only transitions QUEUED -> RUNNING. If another worker already claimed this job (or it was
// somehow already processed), this returns null and the caller skips it - a cheap guard against
// double-processing the same job twice.
export async function claimSubmission(id, workerId) {
  const result = await pool.query(
    `UPDATE submissions
     SET status = 'RUNNING', started_at = now(), worker_id = $2
     WHERE id = $1 AND status = 'QUEUED'
     RETURNING id`,
    [id, workerId],
  );
  return result.rows.length > 0;
}

// Phase 3 stub: proves the queue -> worker -> DB path end-to-end without touching Judge0 yet.
// Phase 4 replaces this with a real submit-to-Judge0 + persist-result step.
export async function markCompletedStub(id, workerId) {
  await pool.query(
    `UPDATE submissions
     SET status = 'COMPLETED', completed_at = now(),
         stdout = $2
     WHERE id = $1`,
    [id, `[stub] processed by ${workerId} (Judge0 integration lands in Phase 4)`],
  );
}
