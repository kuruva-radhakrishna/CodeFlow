import { nanoid } from 'nanoid';
import { enqueueSubmission } from '@codeflow/queue';
import { pool } from '../db/pool.js';
import { redis } from '../queue/client.js';
import { SubmissionStatus } from './submissionStatus.js';

const ROW_TO_DTO_FIELDS = `
  id, idempotency_key AS "idempotencyKey", user_id AS "userId", language_id AS "languageId",
  source_code AS "sourceCode", stdin, status, execution_status AS "executionStatus",
  judge0_token AS "judge0Token",
  stdout, stderr, compile_output AS "compileOutput",
  execution_time AS "executionTime", memory_used AS "memoryUsed",
  retry_count AS "retryCount", attempt_count AS "attemptCount",
  worker_id AS "workerId", error_message AS "errorMessage",
  lease_until AS "leaseUntil", last_heartbeat_at AS "lastHeartbeatAt",
  created_at AS "createdAt", queued_at AS "queuedAt", started_at AS "startedAt", completed_at AS "completedAt"
`;

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency-Key was already used with a different request');
    this.name = 'IdempotencyConflictError';
  }
}

function requestMatchesExisting(existing, { languageId, sourceCode, stdin }) {
  return (
    existing.languageId === languageId &&
    existing.sourceCode === sourceCode &&
    (existing.stdin ?? '') === (stdin ?? '')
  );
}

async function findByIdempotencyKey(userId, idempotencyKey) {
  const result = await pool.query(
    `SELECT ${ROW_TO_DTO_FIELDS} FROM submissions WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

// Same key + same request -> replay the original (no new work). Same key + a DIFFERENT request ->
// reject outright rather than silently returning someone else's result for a different program.
function resolveAgainstExisting(existing, incoming) {
  if (!requestMatchesExisting(existing, incoming)) {
    throw new IdempotencyConflictError();
  }
  return { submission: existing, replayed: true };
}

export async function createSubmission({ userId, languageId, sourceCode, stdin, idempotencyKey }) {
  const incoming = { languageId, sourceCode, stdin };

  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(userId, idempotencyKey);
    if (existing) {
      return resolveAgainstExisting(existing, incoming);
    }
  }

  const id = `sub_${nanoid(10)}`;
  try {
    const result = await pool.query(
      `INSERT INTO submissions (id, idempotency_key, user_id, language_id, source_code, stdin, status, queued_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       RETURNING ${ROW_TO_DTO_FIELDS}`,
      [id, idempotencyKey ?? null, userId, languageId, sourceCode, stdin ?? '', SubmissionStatus.QUEUED],
    );
    await enqueueSubmission(redis, id);
    return { submission: result.rows[0], replayed: false };
  } catch (err) {
    // Lost a race to a concurrent request with the same (user_id, idempotency_key) - the unique
    // index (not a check-then-act SELECT) is the actual authority here. Whoever's INSERT landed
    // first wins; we just look up what they created and resolve against it like any other replay.
    if (err.code === '23505' && idempotencyKey) {
      const winner = await findByIdempotencyKey(userId, idempotencyKey);
      if (winner) {
        return resolveAgainstExisting(winner, incoming);
      }
    }
    throw err;
  }
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
