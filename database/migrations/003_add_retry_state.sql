-- Retry state lives in Postgres, not Redis-only, so a worker crash during backoff doesn't lose
-- the retry decision - Redis stays "what needs processing", Postgres stays "what is the
-- authoritative state of this submission". retry_count already existed (reserved in migration 001)
-- and is now actually used: it counts DELIBERATE retry-after-failure attempts specifically,
-- independent of attempt_count (which counts every real claim, including Phase 5 crash recoveries)
-- - a flaky worker environment shouldn't eat into a job's legitimate retry budget.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS failure_reason TEXT;

CREATE INDEX IF NOT EXISTS submissions_pending_retry_idx
    ON submissions (next_retry_at)
    WHERE status = 'RETRYING';
