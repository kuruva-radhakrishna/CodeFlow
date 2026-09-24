-- CodeFlow: submission state, the durable source of truth for the platform.
-- Redis owns transient/coordination state (queue, rate limits, leases); this table owns everything else.

CREATE TABLE IF NOT EXISTS submissions (
    id              TEXT PRIMARY KEY,              -- e.g. sub_8f23a
    idempotency_key TEXT,                           -- client-supplied, scoped per user
    user_id         TEXT NOT NULL,
    language_id     INTEGER NOT NULL,
    source_code     TEXT NOT NULL,
    stdin           TEXT NOT NULL DEFAULT '',

    status          TEXT NOT NULL DEFAULT 'QUEUED'
                    CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED')),

    -- What the user's PROGRAM did, as distinct from whether OUR infrastructure succeeded.
    -- A COMPLETED job can have execution_status=RUNTIME_ERROR (that's the user's bug, not ours);
    -- status only goes FAILED when Judge0/the worker itself couldn't produce a result.
    execution_status TEXT
                    CHECK (execution_status IN (
                        'ACCEPTED', 'WRONG_ANSWER', 'COMPILATION_ERROR', 'RUNTIME_ERROR',
                        'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'OTHER'
                    )),

    judge0_token    TEXT,
    stdout          TEXT,
    stderr          TEXT,
    compile_output  TEXT,
    execution_time  NUMERIC,
    memory_used     INTEGER,

    -- Deliberate retry-after-failure budget (Phase 7), independent of attempt_count below: a
    -- flaky worker environment causing crash recoveries shouldn't eat into a job's retry budget.
    -- next_retry_at/failure_reason live here (not Redis-only) so a worker crash during backoff
    -- doesn't lose the retry decision - Redis stays "what needs processing", Postgres stays "what
    -- is the authoritative state of this submission".
    retry_count     INTEGER NOT NULL DEFAULT 0,
    next_retry_at   TIMESTAMPTZ,
    failure_reason  TEXT,
    worker_id       TEXT,
    error_message   TEXT,

    -- Job lease: a RUNNING submission is only "alive" while lease_until is in the future. A
    -- worker renews it (heartbeat) while genuinely working; a crashed worker just stops renewing
    -- it, and the reaper (see worker/src/reaper.js) recovers the job once it expires - no worker
    -- needs to notice its own death. attempt_count counts claims, including crash-recovery
    -- reclaims (distinct from retry_count above, which is for Phase 7's retry-after-failure).
    lease_until       TIMESTAMPTZ,
    last_heartbeat_at TIMESTAMPTZ,
    attempt_count     INTEGER NOT NULL DEFAULT 0,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    queued_at       TIMESTAMPTZ,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

-- one idempotency key maps to exactly one submission, per user
CREATE UNIQUE INDEX IF NOT EXISTS submissions_user_idempotency_key_idx
    ON submissions (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS submissions_user_id_idx ON submissions (user_id);
CREATE INDEX IF NOT EXISTS submissions_status_idx ON submissions (status);
CREATE INDEX IF NOT EXISTS submissions_created_at_idx ON submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS submissions_stale_lease_idx ON submissions (lease_until) WHERE status = 'RUNNING';
CREATE INDEX IF NOT EXISTS submissions_pending_retry_idx ON submissions (next_retry_at) WHERE status = 'RETRYING';
