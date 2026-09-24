import { nanoid } from 'nanoid';
import { enqueueSubmission } from '@codeflow/queue';
import { pool } from '../db/pool.js';
import { redis } from '../queue/client.js';
import { SubmissionStatus } from './submissionStatus.js';

const ROW_TO_DTO_FIELDS = `
  id, idempotency_key AS "idempotencyKey", user_id AS "userId", language_id AS "languageId",
  source_code AS "sourceCode", stdin, status, judge0_token AS "judge0Token",
  stdout, stderr, compile_output AS "compileOutput",
  execution_time AS "executionTime", memory_used AS "memoryUsed",
  retry_count AS "retryCount", worker_id AS "workerId", error_message AS "errorMessage",
  created_at AS "createdAt", queued_at AS "queuedAt", started_at AS "startedAt", completed_at AS "completedAt"
`;

export async function createSubmission({ userId, languageId, sourceCode, stdin, idempotencyKey }) {
  if (idempotencyKey) {
    const existing = await pool.query(
      `SELECT ${ROW_TO_DTO_FIELDS} FROM submissions WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    if (existing.rows.length > 0) {
      return { submission: existing.rows[0], replayed: true };
    }
  }

  const id = `sub_${nanoid(10)}`;
  const result = await pool.query(
    `INSERT INTO submissions (id, idempotency_key, user_id, language_id, source_code, stdin, status, queued_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     RETURNING ${ROW_TO_DTO_FIELDS}`,
    [id, idempotencyKey ?? null, userId, languageId, sourceCode, stdin ?? '', SubmissionStatus.QUEUED],
  );

  await enqueueSubmission(redis, id);

  return { submission: result.rows[0], replayed: false };
}

export async function getSubmissionById(id) {
  const result = await pool.query(`SELECT ${ROW_TO_DTO_FIELDS} FROM submissions WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function listSubmissionsForUser(userId, { limit = 20 } = {}) {
  const result = await pool.query(
    `SELECT ${ROW_TO_DTO_FIELDS} FROM submissions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return result.rows;
}
