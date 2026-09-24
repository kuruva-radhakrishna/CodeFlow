-- Job leases: a RUNNING submission is only "alive" while its lease_until is in the future.
-- A worker renews the lease (heartbeat) while it's actually working; if it dies, the lease
-- simply stops being renewed and expires on its own - no worker needs to notice its own death.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS submissions_stale_lease_idx
    ON submissions (lease_until)
    WHERE status = 'RUNNING';
