import { pool } from './db.js';

// Only transitions QUEUED -> RUNNING, and only for a worker that doesn't already own another
// attempt on this row. Guards against double-processing the same job twice. Grants a fresh lease
// and bumps attempt_count (this may be a crash-recovery reclaim, not the job's first attempt).
export async function claimSubmission(id, workerId, leaseSeconds) {
  const result = await pool.query(
    `UPDATE submissions
     SET status = 'RUNNING', started_at = now(), worker_id = $2,
         lease_until = now() + ($3 || ' seconds')::interval,
         last_heartbeat_at = now(),
         attempt_count = attempt_count + 1
     WHERE id = $1 AND status = 'QUEUED'
     RETURNING id`,
    [id, workerId, String(leaseSeconds)],
  );
  return result.rows.length > 0;
}

// Heartbeat: proves the worker is still alive and still owns this job. If this returns false,
// ownership was already lost (the reaper recovered it, or another worker claimed it) - the
// caller should treat whatever result it eventually gets from Judge0 as moot.
export async function renewLease(id, workerId, leaseSeconds) {
  const result = await pool.query(
    `UPDATE submissions
     SET lease_until = now() + ($3 || ' seconds')::interval, last_heartbeat_at = now()
     WHERE id = $1 AND status = 'RUNNING' AND worker_id = $2
     RETURNING id`,
    [id, workerId, String(leaseSeconds)],
  );
  return result.rows.length > 0;
}

export async function getSubmissionForExecution(id) {
  const result = await pool.query(
    `SELECT id, language_id AS "languageId", source_code AS "sourceCode", stdin FROM submissions WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

// The job succeeded (our infrastructure produced a result) regardless of whether the user's
// program itself was accepted, errored, or timed out - that verdict lives in execution_status.
// Ownership-guarded: only writes if this worker still owns the RUNNING row. If a stale worker's
// Judge0 call finally resolves after another worker has already taken over, this returns false
// and the caller MUST discard the result rather than overwrite the current owner's work.
export async function completeExecution(id, workerId, result) {
  const r = await pool.query(
    `UPDATE submissions
     SET status = 'COMPLETED', completed_at = now(),
         execution_status = $3, stdout = $4, stderr = $5, compile_output = $6,
         execution_time = $7, memory_used = $8, judge0_token = $9
     WHERE id = $1 AND status = 'RUNNING' AND worker_id = $2
     RETURNING id`,
    [
      id,
      workerId,
      result.executionStatus,
      result.stdout,
      result.stderr,
      result.compileOutput,
      result.executionTime,
      result.memoryUsed,
      result.judge0Token,
    ],
  );
  return r.rows.length > 0;
}

// The job failed - OUR infrastructure (Judge0 itself, the network, the worker) couldn't produce
// a result. Distinct from the user's program failing, which is still status=COMPLETED.
// Ownership-guarded for the same reason as completeExecution.
export async function failSubmission(id, workerId, errorMessage) {
  const r = await pool.query(
    `UPDATE submissions SET status = 'FAILED', completed_at = now(), error_message = $3
     WHERE id = $1 AND status = 'RUNNING' AND worker_id = $2
     RETURNING id`,
    [id, workerId, errorMessage],
  );
  return r.rows.length > 0;
}
