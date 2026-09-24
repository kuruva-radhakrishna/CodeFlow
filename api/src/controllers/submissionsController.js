import { z } from 'zod';
import {
  createSubmission,
  getSubmissionById,
  listSubmissionsForUser,
  IdempotencyConflictError,
} from '../services/submissions.js';
import { checkRateLimit } from '../services/rateLimiter.js';

const createSubmissionSchema = z.object({
  userId: z.string().min(1),
  languageId: z.number().int().positive(),
  sourceCode: z.string().min(1),
  stdin: z.string().optional().default(''),
});

export async function postSubmission(req, res, next) {
  try {
    const body = createSubmissionSchema.parse(req.body);

    // Rate limit first, before idempotency or any persistence - a rejected request must leave
    // zero trace in Postgres or Redis. Not applied to worker-side lease recovery (the reaper
    // never calls this endpoint; it talks to Postgres/Redis directly) - recovering an abandoned
    // job is internal system work, not a new client submission.
    const rateLimit = await checkRateLimit(body.userId);
    if (!rateLimit.allowed) {
      return res.status(429).json({
        error: 'rate_limited',
        message: `Exceeded ${rateLimit.limit} submissions/minute`,
      });
    }

    const idempotencyKey = req.get('Idempotency-Key') || undefined;

    const { submission, replayed } = await createSubmission({ ...body, idempotencyKey });

    res.status(replayed ? 200 : 202).json({
      submissionId: submission.id,
      status: submission.status,
      replayed,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'invalid_request', details: err.issues });
    }
    if (err instanceof IdempotencyConflictError) {
      return res.status(409).json({ error: 'IDEMPOTENCY_KEY_REUSED', message: err.message });
    }
    next(err);
  }
}

export async function getSubmission(req, res, next) {
  try {
    const submission = await getSubmissionById(req.params.id);
    if (!submission) {
      return res.status(404).json({ error: 'not_found' });
    }
    res.json(submission);
  } catch (err) {
    next(err);
  }
}

export async function getSubmissionResult(req, res, next) {
  try {
    const submission = await getSubmissionById(req.params.id);
    if (!submission) {
      return res.status(404).json({ error: 'not_found' });
    }
    res.json({
      submissionId: submission.id,
      status: submission.status,
      executionStatus: submission.executionStatus,
      stdout: submission.stdout,
      stderr: submission.stderr,
      compileOutput: submission.compileOutput,
      executionTime: submission.executionTime,
      memoryUsed: submission.memoryUsed,
      errorMessage: submission.errorMessage,
    });
  } catch (err) {
    next(err);
  }
}

export async function listUserSubmissions(req, res, next) {
  try {
    const submissions = await listSubmissionsForUser(req.params.userId);
    res.json({ submissions });
  } catch (err) {
    next(err);
  }
}
