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

    judge0_token    TEXT,
    stdout          TEXT,
    stderr          TEXT,
    compile_output  TEXT,
    execution_time  NUMERIC,
    memory_used     INTEGER,

    retry_count     INTEGER NOT NULL DEFAULT 0,
    worker_id       TEXT,
    error_message   TEXT,

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
