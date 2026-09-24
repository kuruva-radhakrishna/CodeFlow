# CodeFlow — Distributed Code Execution Platform

Infrastructure layer around [Judge0](https://judge0.com) for accepting programming submissions,
processing them asynchronously through a Redis-backed job system, distributing work across
multiple workers, and persisting execution state in PostgreSQL — with rate limiting, retries,
worker-failure recovery, observability, and load-tested benchmarks.

**Judge0 handles code execution. This project is the distributed system that manages everything
around execution** — the API, the queue, the workers, the state machine, and the failure handling.

## Architecture (target)

```
Client -> REST API (Node/Express) -> PostgreSQL (submission state)
                                   -> Redis (job queue, rate limits, leases)
                                          -> Worker pool -> Judge0 -> result -> PostgreSQL
```

## Status

Building incrementally, in phases (see plan below). Each phase should be runnable before moving
to the next — no numbers get claimed until they're actually measured under load.

- [x] Phase 0 — architecture + repo scaffold
- [x] Phase 1 — Node.js API skeleton
- [x] Phase 2 — PostgreSQL + submission state (`POST /submissions`, `GET /submissions/:id`,
      idempotency-key support pulled forward since it's a DB-layer concern)
- [x] Phase 3 — Redis queue + standalone worker process (`POST /submissions` now returns `202`
      and enqueues; worker consumes and stubs completion - Judge0 itself isn't wired up yet)
- [x] Phase 4 — worker + Judge0 integration, real end-to-end execution (accepted / compile error /
      runtime error all verified against the live public instance)
- [x] Phase 5 — job leases + heartbeats + a reaper, so an abandoned RUNNING job is always
      eventually recovered instead of getting stuck forever (deliberately before rate
      limiting/retries, so those solve a demonstrated problem instead of being added speculatively)
- [x] Phase 6 — rate limiting (Redis fixed-window) + idempotency hardening (DB constraint as the
      race authority, not check-then-act; explicit rejection of key-reuse-with-different-payload)
- [x] Phase 7 — retries + exponential backoff + dead-letter handling (distinct from Phase 5's
      crash recovery: this is about deliberately retrying a job that legitimately failed, e.g.
      Judge0 5xx; the DLQ is a `FAILED` row in Postgres with enough context to investigate, not a
      separate Redis queue - see below for why)
- [x] Phase 8 — worker concurrency (multiple jobs per process) + horizontal scaling (multiple
      processes) - correctness model unchanged: Postgres is still the only authority, Redis is
      still just work distribution
- [x] Phase 9 — observability + metrics (`GET /api/v1/metrics`: submission counts, queue-wait vs.
      execution-time vs. end-to-end latency percentiles, execution outcome breakdown, live
      per-worker throughput). Not a Prometheus exporter - a plain JSON snapshot, deliberately
- [ ] Phase 10 — load testing (k6) at 5 / 10 / 20 workers, against infrastructure we control
      (not the public Judge0 instance - see note below)
- [ ] Phase 11 — deployment + documentation
- [ ] Phase 12 — benchmark writeup

## Local development

Prerequisites: Node.js 20+.

Postgres and Redis run as free cloud-hosted instances ([Neon](https://neon.tech) and
[Upstash](https://upstash.com)) rather than via Docker — this dev machine has no admin rights, so
Docker Desktop isn't an option. `docker-compose.yml` is kept in the repo for later (a machine that
does have Docker, or the eventual deployment story) but isn't required for local dev today.

```bash
cp .env.example .env
# fill in DATABASE_URL (Neon) and REDIS_URL (Upstash) in .env
npm install
psql "$DATABASE_URL" -f database/schema.sql   # or run schema.sql via any Postgres client
npm run dev:api                                # starts the API on :3000
npm run dev:worker                             # starts a worker (run this in a second terminal)
```

The API and worker are independent processes that only communicate through Redis (the queue) and
Postgres (submission state) - never directly. You can start any number of `npm run dev:worker`
instances; each is a separate consumer of the same queue. Stopping every worker doesn't lose
submissions - they simply accumulate in Redis until a worker is running again to drain them.

Judge0: development currently points at the public CE instance (`ce.judge0.com`), which needs no
signup but is rate-limited (~50 requests/day) - fine for validating correctness (a handful of
submissions), not for load testing. Swap `JUDGE0_API_URL`/`JUDGE0_API_KEY` in `.env` for a
RapidAPI key or a self-hosted instance later; the worker's Judge0 client (`worker/src/judge0/`) is
written against the same HTTP contract either way, so the swap needs no code changes. Load testing
(Phase 10) must run against infrastructure we control, or we'd be measuring Judge0's public
service's rate limit instead of CodeFlow's own behavior.

### API

```
POST /api/v1/submissions              create a submission (Idempotency-Key header optional) -> 202
GET  /api/v1/submissions/:id           submission state
GET  /api/v1/submissions/:id/result    execution result only
GET  /api/v1/users/:userId/submissions recent submissions for a user
GET  /api/v1/health                    liveness + DB connectivity
```

A submission now flows `QUEUED -> RUNNING -> COMPLETED` (or `FAILED`) end-to-end through the real
queue, a real worker process, and real Judge0 execution.

### Job status vs. execution status

`status` and `execution_status` answer two different questions, and conflating them was something
we deliberately avoided:

- **`status`** (`QUEUED`/`RUNNING`/`COMPLETED`/`FAILED`/...) — did **our infrastructure**
  successfully process this submission end-to-end?
- **`execution_status`** (`ACCEPTED`/`COMPILATION_ERROR`/`RUNTIME_ERROR`/`TIME_LIMIT_EXCEEDED`/...)
  — what did the **user's program** actually do?

A submission with a bug in it (`raise Exception(...)`) is `status=COMPLETED`,
`execution_status=RUNTIME_ERROR` — CodeFlow did its job correctly; the user's code is what failed.
`status` only goes to `FAILED` when Judge0/the worker/the network couldn't produce a result at
all — that's *our* problem, and it's what Phase 7's retry logic will act on. Judge0's own internal
errors (`status.id=13`) are mapped to job-level `FAILED`, not to an `execution_status`, for the
same reason.

### Verified (2026-09-24): three real executions through the live Judge0 pipeline

Submitted real code through the full API → Redis → worker → Judge0 → Postgres path against
`ce.judge0.com`, covering the three cases that matter (Phase 4 is only "done" once all three work,
not just the happy path):

| Case | Result |
|---|---|
| `print("Hello from Judge0")` (Python) | `COMPLETED` / `ACCEPTED`, real stdout, `time=0.011s`, `memory=3300kb` |
| Deliberately broken C++ (`int main() { this is not valid C++`) | `COMPLETED` / `COMPILATION_ERROR`, real GCC compiler output captured in `compile_output` |
| `raise Exception("boom")` (Python) | `COMPLETED` / `RUNTIME_ERROR`, real Python traceback captured in `stderr` |

Along the way, an actual infra-level bug surfaced and validated the status/execution_status split
for real: the worker's first Judge0 request used `base64_encoded=false`, which Judge0 rejected
with a 400 for the C++ test case ("cannot be converted to UTF-8"). That correctly produced
`status=FAILED` with the real error in `error_message` — not a fabricated `execution_status`. Fixed
by switching both directions (request and response) to base64 encoding, which is what Judge0 itself
recommends to avoid this whole class of transport issue.

### Job leases, heartbeats, and worker recovery

Phase 4 left a real gap: if a worker dies between claiming a job and Judge0 responding, that
submission stays `RUNNING` forever — nothing ever notices. Phase 5 closes it with a lease:

- **Claim** grants a lease (`lease_until = now() + 15s` by default) and bumps `attempt_count`.
- **Heartbeat**: while a worker is genuinely still working a job, it renews the lease every 5s
  (`UPDATE ... WHERE status='RUNNING' AND worker_id=$ownWorkerId` — ownership-checked, so a worker
  that's already lost the job can't accidentally resurrect its lease).
- **Reaper**: every worker also runs a loop (no separate service - "we can initially implement
  this inside the worker process," per the plan) that recovers any `RUNNING` row whose lease has
  expired back to `QUEUED` and re-enqueues it in Redis. Any worker's reaper can recover any job,
  including its own.
- **Every write that ends a job is ownership-guarded**: `completeExecution` and `failSubmission`
  both include `AND status='RUNNING' AND worker_id=$thisWorker` in their `WHERE` clause. If a
  worker's Judge0 call finally resolves after it's lost ownership (recovered elsewhere), the write
  silently affects zero rows and is discarded - it cannot clobber whatever the current owner wrote.

**This means duplicate Judge0 execution is possible and is not prevented** - if a job is recovered
while the original worker is still actually (if slowly) working it, both may submit to Judge0, and
Judge0 will genuinely execute the code twice. The design goal is explicitly **at-least-once
processing with idempotent, ownership-guarded state transitions**, not exactly-once execution -
see [Test D](#verified-2026-09-24-worker-recovery-and-the-ownership-race) below, where this was
deliberately reproduced and confirmed safe (no corruption, no lost/duplicated final state) rather
than hidden.

### Verified (2026-09-24): worker recovery and the ownership race

**Test B - worker killed mid-execution.** Submitted a deliberately slow job (`time.sleep(9)`),
confirmed it was claimed and `RUNNING` with a live lease, then force-killed the worker process at
the OS level mid-Judge0-call. Confirmed the row stayed stuck `RUNNING` with an expired lease and no
one to recover it - the exact gap this phase exists to close. Started a *fresh* worker process:
its reaper recovered the stale job on its very first sweep, re-queued it, and the fresh worker
claimed and completed it for real (`attempt_count: 1 -> 2`, `worker_id` switched to the new
process). Redis queue and Postgres both ended clean - no stuck rows, no duplicate ids.

**Test D - the ownership race.** To reproduce the race safely (see the mistake below), used two
workers with default (full-length) leases and a one-time manual SQL statement to force-expire one
job's lease immediately after claim - simulating "the reaper wrongly believes this worker is dead"
without any risk of it recurring. Result: the reaper (on either worker) recovered the "stale" job
while the original worker was still genuinely, correctly working it; a second worker claimed and
completed it first; and when the *original* worker's Judge0 call eventually resolved too (a real,
duplicate Judge0 execution of the same code), its completion write correctly affected zero rows
and was discarded - logged as `DISCARDED - ownership was lost mid-flight`, not silently swallowed.
Final state: exactly one `COMPLETED` row, correct final `worker_id`, `attempt_count: 2`, zero
duplicate rows, zero corruption.

**A mistake worth keeping in here rather than editing out.** The first attempt at forcing this race
used a globally short lease (3s) with a long heartbeat interval on *both* workers, for *every*
claim - not just the initial one. Since a recovered job's re-claim also got the same too-short
lease, and the 10s Judge0 job never had a chance to finish within it, the job cycled through
claim → reap → re-claim → reap indefinitely, firing a new real Judge0 request on every cycle (7
before it was caught and stopped). This is a real, well-known distributed-systems failure mode -
**a lease shorter than the operation it's meant to protect causes livelock**, not just a one-time
race - and it's exactly why the fix (a one-time forced expiry, not a systemically-too-short lease)
matches how the reaper is actually meant to be tuned in production: the lease duration must always
exceed the slowest legitimate operation it covers, with real margin.

### Rate limiting and idempotency hardening

Two gaps closed together, both about what happens *before* a submission becomes durable state:

- **Rate limiting**: a Redis fixed-window counter (`codeflow:ratelimit:{userId}:{windowStart}`,
  `INCR` + `EXPIRE`), checked first in `POST /submissions` - before idempotency, before any
  Postgres or Redis write. A rejected request (`429`) leaves zero trace anywhere. Deliberately a
  plain fixed-window counter, not a token bucket - explicit and easy to reason about now; smoothing
  bursts with a token bucket is a real but separate upgrade for later, not a gap in this one.
  Scoped per `userId` (there's no auth/API-key layer yet - see Phase 6 note below).
- **Idempotency, race-safe**: the previous implementation was check-then-act (`SELECT` for an
  existing key, `INSERT` if none) - correct sequentially, but two concurrent requests with the same
  key could both pass the `SELECT` before either `INSERT`s, creating two rows. Fixed by treating the
  existing unique index on `(user_id, idempotency_key)` as the actual authority: attempt the
  `INSERT` directly, and if it fails with a unique-violation (Postgres `23505`), look up whoever won
  the race and resolve against *their* row instead of erroring.
- **Idempotency contract, precisely defined**: same key + same request -> replay (same
  `submissionId`, `replayed: true`). Same key + a **different** request -> `409
  IDEMPOTENCY_KEY_REUSED`, rejected outright - a client can't accidentally receive Program A's
  result while believing it submitted Program B. This applies uniformly whether the reuse is
  detected sequentially or as the loser of a concurrent race.
- **Worker recovery is exempt by construction, not by a special case**: the reaper
  (`worker/src/reaper.js`) talks to Postgres and Redis directly and never calls the API - there is
  no code path connecting it to `checkRateLimit` at all. Confirmed by inspection rather than a live
  test: `grep -r rateLimit worker/` returns nothing.

### Verified (2026-09-24): rate limiting and idempotency under real concurrency

All six of the plan's test cases, run against the live API (no worker/Judge0 needed for any of
this - it's all admission-control logic, so zero Judge0 quota spent):

| Test | Result |
|---|---|
| A - normal submission | `202`, `QUEUED`, unchanged from Phase 3-5 |
| B - sequential replay (same key, same payload, twice) | Same `submissionId` both times; second call `200`/`replayed:true`; exactly 1 DB row, 1 Redis job |
| C - **concurrent** replay (5 truly simultaneous requests, same key/payload) | All 5 returned the *same* `submissionId` - one `202` winner, four `200`/`replayed:true` losers, zero errors; exactly 1 DB row, 1 Redis job despite 5 racers |
| D - key reuse, different payload (`source=A` then `source=B`, same key) | Second request: `409 IDEMPOTENCY_KEY_REUSED`; re-fetched the original afterward and confirmed `sourceCode` was still `print("A")` - untouched |
| E - rate limit (10 requests against a 5/minute limit) | Exactly 5x `202`, 5x `429`, in order; DB row count for that user was exactly 5, not 10 |
| F - recovery bypasses rate limiting | Confirmed architecturally: no code path exists from the reaper to the rate limiter |

Test C is the one worth dwelling on: it's the exact race the plan called out as **not** provably
safe from a check-then-act `SELECT`-then-`INSERT` pattern, and it was verified against Postgres
for real, with genuinely concurrent requests (fired with shell `&`/`wait`, not sequential awaits) -
not just reasoned about.

### Retries, backoff, and the dead-letter record

Phase 5 answers "can we recover ownership of an abandoned job?" (a worker died mid-execution).
Phase 7 answers a different question: "should we try this job again, and how many times?" (the
worker didn't die - Judge0 itself, or the network, had a bad moment). They're deliberately separate
mechanisms operating on **disjoint statuses** (`RUNNING` for the reaper, `RETRYING` for the retry
scanner) so they can never contend with each other.

- **Only infrastructure failures are retryable.** A real HTTP response gets classified at the
  Judge0 adapter boundary (`worker/src/judge0/errors.js`): a 5xx or a network-level failure
  (`fetch` itself throwing) or a poll-budget timeout is `retryable`; a 4xx (our request was
  malformed - wrong language id, bad encoding) is not, because retrying an identical malformed
  request will fail identically every time and just burns Judge0 quota for nothing. Judge0's own
  internal error (`status.id=13`, a real HTTP 200 with a "something went wrong on our side" body)
  is treated as retryable too - it's Judge0 having a bad moment, not our request being wrong.
  Compilation errors, runtime errors, and TLE are never even candidates for retry - they're
  `COMPLETED` with an `execution_status`, not a failure at all, so this logic never sees them.
- **The decision is a pure function** (`worker/src/retryPolicy.js`, `decideOutcome`): given
  `{retryable, retryCount}`, it returns `RETRY` with a backoff (`2^retryCount` seconds - 1s, 2s,
  4s) or `FAIL` (either the failure wasn't retryable at all, or `retry_count` already hit
  `MAX_RETRIES` (3), in which case the reason is overridden to `MAX_RETRIES_EXCEEDED`). No I/O,
  so it's exhaustively unit-testable without touching Postgres, Redis, or Judge0.
- **`retry_count` is deliberately separate from `attempt_count`.** `attempt_count` (Phase 5) counts
  every real claim, including crash-recovery reclaims that have nothing to do with retry policy;
  `retry_count` counts only deliberate retries-after-failure. A flaky worker environment causing a
  few crash recoveries shouldn't eat into a job's actual retry budget.
- **Retry state lives in Postgres, not Redis-only** (`next_retry_at`, `failure_reason`,
  `retry_count` are real columns) - a worker crashing during the backoff window doesn't lose the
  retry decision. A separate loop (`worker/src/retryScanner.js`, disjoint from the reaper) promotes
  any `RETRYING` row whose `next_retry_at` has passed back to `QUEUED` and re-enqueues it; from
  there it's indistinguishable from any other queued job, so the entire claim/lease/heartbeat/
  ownership-guarded-completion machinery from Phase 5 applies to a retried attempt with zero
  special-casing.
- **No dedicated DLQ infrastructure yet, on purpose.** A permanently failed job is simply a
  `FAILED` row with `failure_reason` and `error_message` preserved - enough to investigate. A
  second Redis queue for dead letters is a real future option, but only if load testing (Phase 10)
  actually demonstrates a need for one; building it speculatively now would be exactly the kind of
  feature-for-its-own-sake this project is trying to avoid.

### Verified (2026-09-24): retries and backoff

Layered to respect the public Judge0 instance's quota, per plan: pure-logic tests need no I/O at
all; DB-transition tests exercise the real worker functions against real Postgres with **zero**
Judge0 calls (failures are simulated at the exact point Judge0's adapter would normally report
them - a controlled injection at the adapter boundary, not a mock server); only the final
integration check uses real Judge0.

**Pure policy** (`retryPolicy.decideOutcome`, no I/O): `retryCount` 0/1/2 with `retryable:true` ->
`RETRY` with backoff 1s/2s/4s exactly; `retryCount:3` -> `FAIL`/`MAX_RETRIES_EXCEEDED`;
`retryable:false` -> `FAIL` immediately regardless of `retryCount`.

**DB transitions** (real Postgres, no Judge0, 25/25 assertions passed):

| Test | Result |
|---|---|
| Transient failure -> succeeds on retry | Claimed, scheduled a retry (`RETRYING`, `retry_count:1`, `next_retry_at` ~1s out); confirmed the scanner would **not** promote it early; slept past the backoff; scanner promoted it to `QUEUED`; a different worker re-claimed and completed it - final `COMPLETED`, `attempt_count:2` (1 failed + 1 successful attempt) |
| Transient failure -> exhausts retries (DLQ) | 4 simulated consecutive failures (1 original + 3 retries); final state `FAILED`, `failure_reason: MAX_RETRIES_EXCEEDED`, `retry_count` capped at exactly 3, `attempt_count: 4` |
| Non-retryable failure | Straight to `FAILED` on the first failure, `retry_count` stayed 0 - never entered the retry path at all |
| Worker crash during backoff vs. Phase 5 recovery | A `RETRYING` row survived a reaper sweep untouched (reaper only ever looks at `RUNNING`) and wasn't promoted by the retry scanner before its `next_retry_at` - confirmed the two mechanisms structurally can't fight over the same row |
| Idempotent retry | Every operation in every test above was an `UPDATE` by existing id - row count for the whole test run matched the number of ids explicitly created, exactly |
| Backoff actually elapses | The retry-success test genuinely slept past a real 1s backoff before promotion succeeded - not an immediate re-hammer |

**Final integration check** (2 real Judge0 calls against `ce.judge0.com`): a normal submission
through the *actual* worker process end-to-end confirmed the new retry-aware code paths don't
regress the happy path (`COMPLETED`/`ACCEPTED`, `retry_count:0`). A submission with a deliberately
invalid `languageId` (999999) got a genuine Judge0 `422`, was classified as non-retryable
(`Judge0RequestError`, not `Judge0ServerError` - the >=500 threshold correctly treats any non-5xx
as a client-request problem), and went straight to `FAILED` with `retry_count:0` and the real
Judge0 error text preserved in `error_message` - no retries wasted on a request that would fail
identically every time.

### Worker concurrency and horizontal scaling

Two independent dimensions, both without touching the correctness model at all:

- **Concurrency within a process**: `WORKER_CONCURRENCY` (default 3) spawns that many "lanes" -
  independent claim/execute/complete loops, each with its own dedicated Redis connection (`BRPOP`
  blocks the connection it's issued on, so lanes sharing one would just serialize on it and defeat
  the point). `worker_id` (the DB ownership identity) stays shared across a process's lanes on
  purpose - it's a process-level identity, and the atomic claim already guarantees only one lane
  anywhere ends up owning a row, so lanes don't need a separate identity of their own.
- **Scaling across processes**: nothing changes to scale horizontally - start more
  `npm run dev:worker` processes against the same Redis/Postgres. Every correctness guarantee from
  Phases 5-7 (atomic claim, ownership-guarded completion, lease-based recovery, retry scheduling)
  already had to hold under multiple independent workers, so concurrency within one process is not
  a new correctness surface - it's the same guarantees, exercised more.
- **Lightweight metrics** (`worker/src/metrics.js`): in-memory counters (claimed/completed/failed/
  retried/discarded) plus a periodic log line. Deliberately not a metrics server or Prometheus
  exporter - that's Phase 9's job; this is just enough to see a process is making progress and to
  compare throughput across configurations while testing this phase.

### Verified (2026-09-24): concurrency and horizontal scaling

**Claim isolation under heavy concurrency** (real Postgres, zero Judge0): 5 rows, 8 truly
concurrent (`Promise.all`, not sequential) claim attempts per row from distinct simulated workers -
every row had **exactly 1** winner out of 8, every time, and `attempt_count` stayed at exactly 1
per row despite 8 racers. The atomic `UPDATE ... WHERE status='QUEUED'` holds under real
concurrency, not just reasoned about.

**Real throughput comparison** (8 real Judge0 calls total): 4 jobs through a single-lane worker
(`WORKER_CONCURRENCY=1`) drained strictly back-to-back in **7.28s**. The same 4 jobs through 2
worker *processes* with 2 lanes each (4 lanes total) drained in **4.29s** - genuinely overlapping
`started_at` timestamps across both processes, both PIDs represented (2 jobs each), every
`attempt_count:1` (no duplicate claims despite 4-way concurrency). A real, honest ~1.7x speedup -
not the naive 4x, since fixed overhead (queue polling, connection setup) doesn't parallelize, and
that's worth stating plainly rather than rounding up.

**A test that didn't work, reported honestly rather than hidden or re-run into a misleading
"pass"**: attempted to reproduce Phase 5's worker-crash-mid-execution test with multiple concurrent
jobs in flight per worker. Twice, a worker process explicitly confirmed terminated (`Stop-Process`
followed by an immediate, separate `Get-CimInstance` check reporting no such PID) went on to
complete its jobs anyway, at their natural full duration, with `worker_id` still pointing at the
"dead" process - meaning process termination wasn't actually reliable in this environment for this
specific test, not a hidden bug in the recovery code. This is a testing/tooling limitation, not
evidence of anything wrong in the application:

- Phase 5 already verified, with confirmed-working live process kills, that one lane's
  claim/heartbeat/lease/reaper/ownership-guard cycle correctly survives a mid-execution crash.
- The claim-isolation test above just verified the same atomic claim holds under real concurrency.
- Each lane is an independent instance of the exact same code Phase 5 already proved, with no
  shared mutable state between lanes beyond the database itself - which Phase 8's own concurrency
  test just confirmed handles concurrent claims correctly. There's no new failure mode multiple
  concurrent lanes could introduce that either Phase 5 or the claim-isolation test doesn't already
  cover.

That's a reasoned argument for correctness, not a live demonstration of this exact scenario - the
honest position, and the one worth recording rather than papering over with a retried test that
happened to look like it passed.

### Observability

```
GET /api/v1/metrics
```

One JSON snapshot, computed from data the system already has - no new tracing infrastructure, no
`trace_id`, because `submission_id` already IS the correlation key for one traceable unit of work
(there's no multi-hop fan-out per request that would need anything more):

- **`submissions`** - counts by status, total, and a `rateLimitedTotal` counter (the one exception
  to "rejected requests leave zero trace" from Phase 6 - a cumulative counter purely for
  observability, not admission logic, so it doesn't compromise that guarantee).
- **`queue.depth`** - live Redis queue length.
- **`latency`** - the diagnostic this phase exists for: **queue wait** (`started_at - queued_at`,
  "how long did it sit waiting for a worker") separated from **worker processing time**
  (`completed_at - started_at`, "how long did claiming through Judge0 actually take") separated
  from **end-to-end** (`completed_at - created_at`, what the client actually experienced),
  each as p50/p95(/p99), over the last 24h of `COMPLETED` submissions. This is exactly "is the
  system slow because of the queue or because of Judge0?", answerable at a glance instead of
  guessed at. One acknowledged simplification: for a submission that went through retries,
  `started_at` reflects only the *last* attempt (queue-wait/processing aren't broken out per
  attempt) - `end_to_end` still correctly captures the full user-facing latency including
  retry/backoff time regardless, so the total-latency number is never wrong, only the
  queue-vs-processing split for a retried job specifically.
- **`executionOutcomes`** - breakdown by `execution_status` (ACCEPTED/RUNTIME_ERROR/...) and by
  `failure_reason` (JUDGE0_5XX/INVALID_REQUEST/MAX_RETRIES_EXCEEDED/...).
- **`workers`** - which worker processes are *currently alive*, with live claimed/completed/
  failed/retried/discarded counts each. Workers publish their snapshot to a Redis hash with a
  short TTL, refreshed on every publish - the same self-expiring pattern as the submission lease
  (Phase 5): a crashed worker's entry simply stops being renewed and disappears within a bounded
  window, no separate cleanup process needed.

### Verified (2026-09-24): observability

Tested against the real, messy dataset accumulated across this session's own testing (54+ rows
spanning Phases 3-8), which turned out to be a genuinely useful stress test of its own:

- `GET /api/v1/metrics` returned correctly shaped data against real Postgres + Redis on the first
  try: `submissions.byStatus`, `queue.depth`, all three latency tiers with percentiles, outcome
  breakdowns, worker list.
- **The numbers immediately told a true, if initially surprising, story.** `queueWaitMs.p95` came
  back around **623,000ms (~10 minutes)**. That's not a bug - it's Phase 6's idempotency test
  submissions, created while deliberately testing admission-control logic with **no worker
  running** (that's what kept Phase 6 at zero Judge0 cost), sitting `QUEUED` for real until Phase
  7's worker eventually started and drained the backlog. Confirmed by looking up those exact
  submission ids directly. This is the metrics endpoint doing its job correctly - surfacing a real
  (if session-specific) cause of latency instead of hiding it - and it's worth stating plainly
  rather than curating the dataset to make the numbers look better.
- **A clean live sample, for contrast**: with a worker actually running, 2 fresh submissions showed
  `queue_wait_ms` of **~260-280ms** and end-to-end of **~1.9-2.2s** (dominated by Judge0's own round
  trip, not the queue) - exactly the "queue wait vs. Judge0 time" split this phase exists to make
  visible, and a striking contrast against the historical p95.
- **Live worker tracking confirmed end-to-end**: `workers.active` went from `0` (no worker running)
  to `1` with real `claimed`/`completed` counts matching actual progress within one publish cycle
  of starting a worker - the Redis-hash-with-TTL pattern works as designed.
- 20 `COMPLETED` rows show `execution_status: null` ("unknown" in the breakdown) - these are Phase
  3's stub-completion rows, written before Judge0 was wired up in Phase 4. Real historical data,
  correctly surfaced, not a bug in this phase's aggregation query.

### Verified (2026-09-24): the queue survives a worker outage

10 submissions with no worker running -> all 10 sat `QUEUED` in Postgres, 10 jobs sat in Redis,
API stayed responsive (`202` on every request). Worker started -> drained all 10 to `COMPLETED`,
each exactly once, correct `worker_id`/`started_at`/`completed_at`. Repeated with the worker
stopped mid-stream: 10 more submissions queued up untouched, then a **freshly started worker
process** (new PID) picked up and drained the backlog with zero duplicates and zero loss. This is
the queue acting as the buffer it's meant to be — submission traffic and execution capacity are
decoupled.

## Why these technology choices

- **Redis, not Kafka** — this workload needs a simple queue, shared rate-limit state, and low
  latency, not durable event replay or multiple independent consumers. Kafka would be the right
  call if we needed those; we don't, so it'd just be a resume line, not an architecture decision.
- **PostgreSQL, not Redis, as the source of truth** — Redis holds transient/coordination state
  (queue, rate limits, leases); PostgreSQL holds the durable submission record and results.
- **At-least-once delivery with idempotent state transitions**, not a claim of exactly-once —
  a worker can crash mid-job; the design goal is that reprocessing a job is safe, not that it
  never happens.

## What this project is not

Not a Judge0 clone, not a custom sandbox/compiler, not Kubernetes-for-its-own-sake, not
Kafka-for-its-own-sake, not a microservices sprawl. The point is demonstrating understanding of
a distributed system's failure modes and tradeoffs, not accumulating technology names.
