-- Job status (QUEUED/RUNNING/COMPLETED/FAILED/...) answers "did CodeFlow's infrastructure
-- successfully process this submission". execution_status answers "what did the user's program
-- actually do" - a COMPLETED job can still have execution_status=RUNTIME_ERROR; that's the user's
-- bug, not ours. A job only goes FAILED when OUR infrastructure couldn't get a result (Judge0
-- unreachable/internal error, worker crash, etc) - see error_message for why.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS execution_status TEXT
    CHECK (execution_status IN (
        'ACCEPTED', 'WRONG_ANSWER', 'COMPILATION_ERROR', 'RUNTIME_ERROR',
        'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'OTHER'
    ));
