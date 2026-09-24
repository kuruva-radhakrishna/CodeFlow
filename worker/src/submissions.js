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

export async function getSubmissionForExecution(id) {
  const result = await pool.query(
    `SELECT id, language_id AS "languageId", source_code AS "sourceCode", stdin FROM submissions WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

// The job succeeded (our infrastructure produced a result) regardless of whether the user's
// program itself was accepted, errored, or timed out - that verdict lives in execution_status.
export async function completeExecution(id, result) {
  await pool.query(
    `UPDATE submissions
     SET status = 'COMPLETED', completed_at = now(),
         execution_status = $2, stdout = $3, stderr = $4, compile_output = $5,
         execution_time = $6, memory_used = $7, judge0_token = $8
     WHERE id = $1`,
    [
      id,
      result.executionStatus,
      result.stdout,
      result.stderr,
      result.compileOutput,
      result.executionTime,
      result.memoryUsed,
      result.judge0Token,
    ],
  );
}

// The job failed - OUR infrastructure (Judge0 itself, the network, the worker) couldn't produce
// a result. Distinct from the user's program failing, which is still status=COMPLETED.
export async function failSubmission(id, errorMessage) {
  await pool.query(
    `UPDATE submissions SET status = 'FAILED', completed_at = now(), error_message = $2 WHERE id = $1`,
    [id, errorMessage],
  );
}
