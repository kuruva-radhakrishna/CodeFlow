# CodeFlow — Distributed Code Execution Platform

Infrastructure layer around [Judge0](https://judge0.com) for accepting programming submissions,
processing them asynchronously through a Redis-backed job system, distributing work across
multiple workers, and persisting execution state in PostgreSQL — with rate limiting, retries,
worker-failure recovery, observability, and load-tested benchmarks.

**Judge0 handles code execution. This project is the distributed system that manages everything
around execution** — the API, the queue, the workers, the state machine, and the failure handling.

This README is the engineering log, with evidence for every claim. For the resume-bullet /
60-second-pitch / anticipated-questions version, see [INTERVIEW_PREP.md](INTERVIEW_PREP.md).

## Live demo

- API: **https://codeflow-api-1r33.onrender.com** (e.g. [`/api/v1/health`](https://codeflow-api-1r33.onrender.com/api/v1/health), [`/api/v1/metrics`](https://codeflow-api-1r33.onrender.com/api/v1/metrics))
- Worker: `codeflow-worker` on Render, running the mock execution provider (Phase 10) - no Judge0
  credentials involved in this deployment at all.

Both run on Render's **free tier**, which spins a service down after ~15 minutes with no incoming
HTTP request to it. That's straightforward for the **API** - any request wakes it, ~50s cold
start, then it's normal. It's a real limitation for the **worker**, worth being precise about
rather than glossing over: the worker's free-tier "up/down" state is driven entirely by HTTP
requests to *its own* URL (the health-check listener from `v1.0.1`, added only so Render has a
port to consider "up" at all) - a new job landing in Upstash is a Redis event, not an HTTP
request, and **does not wake the worker**. If the worker is asleep when a submission is created,
that submission will sit `QUEUED` indefinitely, not just "a bit longer" - nothing about Redis
activity gives Render a reason to spin it back up.

So: **this is a live demo environment, correct and fully verified while the worker is awake, not
an always-on production deployment.** To see a submission actually processed, hit the worker's own
URL first (which wakes it, same as any free-tier web service) *before or shortly after* submitting
a job - not instead of it:

```bash
curl https://codeflow-worker.onrender.com/          # wakes the worker if it was asleep

curl -X POST https://codeflow-api-1r33.onrender.com/api/v1/submissions \
  -H "Content-Type: application/json" \
  -d '{"userId":"you","languageId":71,"sourceCode":"print(\"hello\")","stdin":""}'
# -> {"submissionId":"sub_...","status":"QUEUED","replayed":false}

curl https://codeflow-api-1r33.onrender.com/api/v1/submissions/<id>/result
```

This is a genuine, known limitation of running a queue consumer behind a free-tier HTTP-triggered
platform - not a CodeFlow correctness issue, and not one worth engineering around by, say, adding a
self-ping keep-alive: that would just be working around Render's free tier rather than saying
anything about the distributed system itself. The evidence that actually matters -
[claim isolation](#verified-2026-09-24-concurrency-and-horizontal-scaling),
[worker recovery](#verified-2026-09-24-worker-recovery-and-the-ownership-race), and the
[5/10/20-lane throughput benchmark](#verified-2026-09-24-5-vs-10-vs-20-worker-lanes) - was all
measured locally against the same real Neon/Upstash instances, entirely independent of Render's
free-tier lifecycle behavior, and stands regardless of whether the live worker happens to be awake
right now.

Deployed from `v1.0.1` (a small patch on top of the frozen `v1.0.0` - `API_PORT` rename, removed
an unused Judge0 requirement from the API's config, and the worker's health-check listener
described above; see that tag's commit for the full reasoning). Both services were verified live,
end-to-end, against the real Neon/Upstash instances before writing this section down.

## Results at a glance

What follows is a phase-by-phase engineering log with full evidence for each claim - this section
is the summary for someone who wants the headline first. Every number below is **measured**, not
estimated; each links to the section with the actual command output.

- **Queue/system load test**: 100 submissions, constant 10 req/s arrival, mock execution provider,
  concurrency swept 5 → 10 → 20 worker lanes. Peak throughput **9.35 jobs/s**, queue-wait p50
  dropped from **7.3s to 1.3s** as concurrency increased, worker-processing time stayed flat
  (~630-940ms) across all three runs - proving the bottleneck was queue capacity, not execution
  time. **0% failure rate** in all three runs. ([full results](#verified-2026-09-24-5-vs-10-vs-20-worker-lanes))
- **Claim isolation under real concurrency**: 8 genuinely simultaneous claimants per row, across 5
  rows - exactly 1 DB winner every time, zero exceptions. ([evidence](#verified-2026-09-24-concurrency-and-horizontal-scaling))
- **Worker crash recovery**: a real, killed-mid-execution worker process's job was recovered by a
  fresh worker and completed correctly, with zero stuck rows and zero duplicate completions.
  ([evidence](#verified-2026-09-24-worker-recovery-and-the-ownership-race))
- **Retries under real concurrent load**: the load test's simulated failures triggered real
  retry-then-succeed cycles (1-8 per run) with 0% reaching the dead-letter state - previously only
  verified in isolated single-job tests, now proven under actual throughput.
  ([evidence](#verified-2026-09-24-5-vs-10-vs-20-worker-lanes))
- **Idempotency under real concurrency**: 5 genuinely simultaneous requests with the same
  idempotency key and payload → exactly 1 submission created, all 5 callers got the same id.
  ([evidence](#verified-2026-09-24-rate-limiting-and-idempotency-under-real-concurrency))

**What's architectural reasoning, not a live measurement**: the claim that duplicate Judge0
execution is *possible but safe* (proven via a deliberately forced ownership race, not organic
production traffic); that horizontal scaling across multiple machines behaves like scaling lanes
within one process (the underlying guarantees are identical by construction, but multi-machine
network partitions specifically were never tested); and the [failure-mode table](#failure-modes)
below, most of whose rows are individually evidenced elsewhere in this README but are presented
together here as a reference, not as one single end-to-end test.

## Architecture

The target topology - every box below has shipped and been exercised, except the execution
provider swap to a real, non-public Judge0 (RapidAPI/self-hosted), which is a configuration change
away but hasn't itself been benchmarked (see [Load testing](#load-testing-isolating-queuesystem-throughput-from-judge0)):

```
                              ┌──────────────┐
                              │    Client    │
                              └──────┬───────┘
                                     │
                              ┌──────▼───────┐
                              │  API Server   │  Node/Express
                              │ (rate limit,  │
                              │  idempotency) │
                              └───┬───────┬───┘
                                  │       │
                         ┌────────▼──┐ ┌──▼────────┐
                         │ PostgreSQL │ │   Redis   │
                         │  (source   │ │  (queue,  │
                         │  of truth) │ │  leases,  │
                         │            │ │rate limit)│
                         └─────▲──────┘ └─────┬─────┘
                               │              │
                    ┌──────────┴──────┬───────┴──────────┐
                    │                 │                  │
              ┌─────▼─────┐     ┌─────▼─────┐      ┌─────▼─────┐
              │  Worker 1  │     │  Worker 2  │ ...  │  Worker N  │
              │  N lanes   │     │  N lanes   │      │  N lanes   │
              │ (claim/    │     │            │      │            │
              │  lease/    │     │            │      │            │
              │  heartbeat/│     │            │      │            │
              │  retry)    │     │            │      │            │
              └─────┬──────┘     └─────┬──────┘      └─────┬──────┘
                    │                  │                   │
                    └──────────────────┼───────────────────┘
                                       ▼
                              ┌──────────────────┐
                              │ Execution Provider │
                              │  Judge0 (real) or   │
                              │  mock (JUDGE0_      │
                              │  PROVIDER=mock)     │
                              └──────────────────┘
```

Every worker is identical and stateless beyond its in-memory metrics counters - Postgres is the
only durable state, Redis is only work-distribution + coordination. Any worker (any lane, any
process, any machine) can claim any job; the atomic claim + ownership-guarded completion is what
makes that safe (Phases 5-8).

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
- [x] Phase 10 — load testing at 5 / 10 / 20 worker lanes, against a mock execution provider (not
      k6 - see below for why; the real Judge0 instance's quota deliberately isn't part of this)
- [x] Phase 11 — deployment topology, a consolidated [failure-mode table](#failure-modes), a
      zero-Judge0-credential quickstart, and this results-first restructure of the README
- [x] Phase 12 — final resume/interview writeup: see [INTERVIEW_PREP.md](INTERVIEW_PREP.md)

## Local development

Prerequisites: Node.js 20+, and a Postgres + Redis you can point at (see below - either is a
2-minute free signup, no credit card, no Docker required).

### Quickstart (no Judge0 credentials needed)

```bash
git clone <this repo> && cd codeflow
npm install
cp .env.example .env
# fill in DATABASE_URL and REDIS_URL in .env (see "Postgres and Redis" below)
psql "$DATABASE_URL" -f database/schema.sql   # or run schema.sql via any Postgres client

npm run dev:api                                # terminal 1: API on :3000

JUDGE0_PROVIDER=mock npm run dev:worker        # terminal 2: worker, mock execution provider
```

That's a fully working system end to end - submit code, watch it flow through the queue, get a
result back - with **zero external calls to Judge0 and zero Judge0 credentials**. The mock
provider (`worker/src/judge0/mockClient.js`) sits behind the exact same adapter contract as the
real one (Phase 10), so this is genuinely exercising the real queue/worker/retry/lease machinery,
just with simulated execution. This is also what the [load tests](#load-testing-isolating-queuesystem-throughput-from-judge0)
run against.

```bash
curl -X POST http://localhost:3000/api/v1/submissions \
  -H "Content-Type: application/json" \
  -d '{"userId":"me","languageId":71,"sourceCode":"print(\"hello\")","stdin":""}'
# -> {"submissionId":"sub_...","status":"QUEUED","replayed":false}

curl http://localhost:3000/api/v1/submissions/<id>/result
# -> {"status":"COMPLETED","executionStatus":"ACCEPTED","stdout":"mock output for: print(\"hello\")\n",...}
```

### Postgres and Redis

Free cloud-hosted instances ([Neon](https://neon.tech) for Postgres, [Upstash](https://upstash.com)
for Redis) rather than Docker - this project's own dev machine has no admin rights, so Docker
Desktop wasn't an option, and it turned out to need nothing more: both are a signup + connection
string, no local install. `docker-compose.yml` is in the repo for a machine that does have Docker
(or a self-hosted deployment) and defines the same schema/version - either path works identically
from the app's point of view, since it only ever sees a `DATABASE_URL`/`REDIS_URL`.

The API and worker are independent processes that only communicate through Redis (the queue) and
Postgres (submission state) - never directly. You can start any number of `npm run dev:worker`
instances; each is a separate consumer of the same queue. Stopping every worker doesn't lose
submissions - they simply accumulate in Redis until a worker is running again to drain them.

### Optional: real Judge0 execution

Leave `JUDGE0_PROVIDER` unset (or set it to `real`) and the worker talks to an actual Judge0
instance instead of the mock. Development so far has pointed at the public CE instance
(`ce.judge0.com` - needs no signup, but is rate-limited to ~50 requests/day, fine for a handful of
correctness checks, not for load testing). Swap `JUDGE0_API_URL`/`JUDGE0_API_KEY` in `.env` for a
RapidAPI key or a self-hosted instance later; the worker's Judge0 client
(`worker/src/judge0/client.js`) is written against the same HTTP contract either way, so the swap
needs no code changes.

### API

```
POST /api/v1/submissions              create a submission (Idempotency-Key header optional) -> 202
GET  /api/v1/submissions/:id           submission state
GET  /api/v1/submissions/:id/result    execution result only
GET  /api/v1/users/:userId/submissions recent submissions for a user
GET  /api/v1/health                    liveness + DB connectivity
GET  /api/v1/metrics                   submission counts, latency percentiles, active workers
```

A submission now flows `QUEUED -> RUNNING -> COMPLETED` (or `FAILED`) end-to-end through the real
queue, a real worker process, and real Judge0 execution.

## Failure modes

The single most useful reference in this README for understanding what CodeFlow actually
guarantees. Most rows are individually evidenced in the phase-by-phase log below (linked); this
table exists to put them all in one place rather than making someone read the whole log to find
the answer to "what happens if X?"

| Scenario | What happens | Why | Evidence |
|---|---|---|---|
| API process dies before the Redis enqueue | The Postgres `INSERT` either committed or it didn't - if it did, the row is `QUEUED` forever with no matching Redis job (a genuine gap: nothing currently re-derives "QUEUED rows with no queue entry" - see [Known gaps](#known-gaps-not-fixed-honestly-scoped-out)). If the insert itself didn't commit, the client gets a connection error and can safely retry with the same Idempotency-Key. | Postgres commit is the only durability boundary that matters here; enqueue is a separate, non-atomic step. | — |
| API process dies after DB insert + Redis enqueue, before responding | Client gets a connection error but the job is fully durable and queued - a retry with the same Idempotency-Key returns the existing submission rather than creating a duplicate. | Idempotency is enforced by a DB unique constraint, not by the response actually reaching the client. | [Idempotency hardening](#rate-limiting-and-idempotency-hardening) |
| Redis unavailable | New submissions fail at the enqueue step (the API's own DB insert already succeeded, so the row exists but nothing will claim it until Redis is back and something re-queues it - same gap as above). Already-queued jobs simply wait; no data is lost, nothing currently auto-recovers past a Redis outage windowed exactly at insert time. | Redis is coordination/distribution state, never the source of truth - but the current code doesn't yet reconcile Postgres against Redis in the Redis-was-briefly-down case. | — |
| Postgres unavailable | `/health` reports `degraded`; the worker's DB-dependent operations (claim, heartbeat, complete) fail loudly and get logged - no silent data loss, but no automatic recovery either since Postgres genuinely is the source of truth. | By design - there's nothing to substitute for the source of truth. | Phase 1-2 scaffolding |
| Worker crashes mid-execution | The job's lease stops being renewed and expires; the reaper (any live worker, including a fresh one) recovers it back to `QUEUED` and it gets re-processed. Verified with a real OS-level process kill mid-Judge0-call. | Job leases + heartbeats + a reaper (Phase 5) | [Worker recovery](#verified-2026-09-24-worker-recovery-and-the-ownership-race) |
| Lease expires while the worker is still (slowly) alive | A second worker may legitimately claim and complete the same job - Judge0 executes it twice. The **DB write is what's guarded**, not the execution: only the current owner's completion is ever persisted; the stale worker's late write is silently discarded. | Ownership-guarded completion (`WHERE status='RUNNING' AND worker_id=$owner`) | [The ownership race](#verified-2026-09-24-worker-recovery-and-the-ownership-race) |
| Stale worker's result arrives after ownership already changed | Discarded - logged, zero rows affected, does not overwrite the current owner's result. | Same ownership guard as above, applied uniformly to every terminal write (complete, fail, retry-schedule). | Same as above |
| Judge0 returns a 4xx (malformed request - bad language id, etc.) | Goes straight to `FAILED`, **not retried** - an identical retry would fail identically and just waste quota. Verified with a real Judge0 422 on an invalid `languageId`. | `Judge0RequestError` classified as non-retryable at the adapter boundary. | [Retries and backoff](#verified-2026-09-24-retries-and-backoff) |
| Judge0 returns a 5xx, times out, or the network fails | Retried with exponential backoff (1s/2s/4s), up to 3 times; only goes to `FAILED`/dead-letter after the budget is exhausted. | `Judge0ServerError`/`Judge0NetworkError`/`Judge0TimeoutError` classified as retryable; retry state lives in Postgres so a crash during backoff doesn't lose the decision. | [Retries and backoff](#retries-backoff-and-the-dead-letter-record) |
| Retry budget exhausted (3 retries, all failed) | `status=FAILED`, `failure_reason=MAX_RETRIES_EXCEEDED`, `error_message` preserved - a `FAILED` row IS the dead-letter record, not a separate queue. | Deliberately no separate DLQ infrastructure yet - see [Retries](#retries-backoff-and-the-dead-letter-record) for why. | [DB-transition tests](#verified-2026-09-24-retries-and-backoff) |
| The user's program itself fails (compile error, runtime error, TLE) | `status=COMPLETED` - **not** a CodeFlow failure. `execution_status` carries the verdict (`COMPILATION_ERROR`/`RUNTIME_ERROR`/`TIME_LIMIT_EXCEEDED`). Never retried - it would fail identically every time. | The status/execution_status split (Phase 4) is the whole point of this row. | [Job status vs. execution status](#job-status-vs-execution-status) |
| Two (or more) workers race to claim the same job | Exactly one wins; the rest see `status != 'QUEUED'` and skip it. Verified with 8 genuinely concurrent claimants per row, across 5 rows, with zero double-claims. | Atomic `UPDATE ... WHERE status='QUEUED'` | [Claim isolation](#verified-2026-09-24-concurrency-and-horizontal-scaling) |
| The same job is delivered twice from Redis (duplicate delivery) | Whichever claim arrives first wins the atomic claim; the second sees `status != 'QUEUED'` and no-ops. No special "dedup" logic needed - it's the same guarantee as the row above. | Same atomic claim - at-least-once delivery is fine because claiming is idempotent. | [Claim isolation](#verified-2026-09-24-concurrency-and-horizontal-scaling) |
| Two concurrent requests submit the same Idempotency-Key + same payload | Both return the same `submissionId`; exactly one Postgres row is created despite the race. | DB unique constraint as the race authority, not check-then-act. | [Idempotency under real concurrency](#verified-2026-09-24-rate-limiting-and-idempotency-under-real-concurrency) |
| Same Idempotency-Key reused with a **different** payload | Rejected with `409 IDEMPOTENCY_KEY_REUSED`; the original submission is left untouched. | Explicit payload comparison against the existing row, not silent replay. | [Idempotency under real concurrency](#verified-2026-09-24-rate-limiting-and-idempotency-under-real-concurrency) |
| Client exceeds the per-user rate limit | `429`, zero Postgres/Redis side effects - not even a queued row. | Rate limit checked first, before idempotency, before any write. | [Rate limiting](#verified-2026-09-24-rate-limiting-and-idempotency-under-real-concurrency) |
| A worker crashes while the reaper/retry-scanner never touch it (deep in `time.sleep`) | Eventually recovered by **any** live worker's reaper sweep, including a fresh one started well after the crash - recovery isn't tied to the crashed worker coming back. | Reaper runs in every worker process, operates on any `RUNNING` row with an expired lease, regardless of who owns it. | [Worker recovery](#verified-2026-09-24-worker-recovery-and-the-ownership-race) |

### Known gaps (not fixed, honestly scoped out)

- **A narrow window between the Postgres insert and the Redis enqueue** (API crash, or a Redis
  outage exactly at that moment) can leave a row `QUEUED` in Postgres with no matching Redis job.
  Nothing currently reconciles this - a production version would want a periodic sweep (similar in
  spirit to the reaper) that re-enqueues any `QUEUED` row older than a few seconds with no
  corresponding Redis entry. Not built because it never came up in any of this project's own
  testing (the window is genuinely narrow), and adding it without a way to *demonstrate* the gap
  first would be exactly the kind of speculative feature this project has tried to avoid throughout.
- **Multi-machine network partitions were never tested.** Every "multiple workers" test in this
  project ran multiple *processes on one machine*. The correctness guarantees (atomic claim,
  ownership-guarded writes) don't depend on the workers being on the same machine - Postgres and
  Redis are the only shared state, and both are already accessed over the network (Neon/Upstash) -
  but a genuine network partition between a worker and Postgres specifically, mid-lease, was never
  induced and observed.
- **The real Judge0 execution-provider benchmark** (RapidAPI key or self-hosted, under real load)
  was deliberately not attempted - see [Load testing](#load-testing-isolating-queuesystem-throughput-from-judge0).
- **The live worker isn't guaranteed always-on** - it runs on Render's free Web Service tier
  specifically so it could be deployed at zero cost (see [Live demo](#live-demo)), and that tier's
  wake mechanism is HTTP-request-driven, not Redis-activity-driven: a new job doesn't wake a sleeping
  worker. This is a deployment-platform limitation of the free-tier demo, not a gap in CodeFlow
  itself - deliberately not "fixed" by adding a self-ping keep-alive, since that would just be
  working around Render's free tier rather than demonstrating anything about the distributed system.

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

### Load testing: isolating queue/system throughput from Judge0

The public Judge0 instance's quota (~50 requests/day, and already at ~30 used by this point) simply
cannot survive a real load test - so this phase deliberately does **not** point load at Judge0 at
all. Instead:

- **A mock execution provider** (`worker/src/judge0/mockClient.js`), selected via
  `JUDGE0_PROVIDER=mock`, sitting behind the *exact same* adapter contract as the real client -
  same typed errors (`Judge0ServerError`/`Judge0TimeoutError`), same raw response shape
  (`base64_encoded=true`), same simulated latency and a small simulated failure rate. Nothing
  downstream (`normalizeJudge0Result`, retry classification, `processSubmission`) can tell the
  difference - this is a substitution at the adapter boundary the whole architecture has been
  building toward since Phase 4, not a parallel test-only code path.
- **No k6.** k6 wasn't reliably installable in this environment (no admin rights, and another
  external-binary install saga wasn't worth it after the friction earlier in this project - see
  the environment notes throughout this README). `load-tests/run-load-test.mjs` is a small
  Node-native load generator instead: fires `POST /submissions` at a constant arrival rate
  (fire-and-forget per tick, the same executor model k6's `constant-arrival-rate` uses), spread
  across many simulated `userId`s so Phase 6's per-user rate limiting doesn't confound a
  queue/system throughput test with admission-control behavior. It measures exactly what k6 would
  have: request rate and submit-latency against the real API.
- **This isolates two genuinely different bottlenecks that a naive "load test the whole thing
  through Judge0" approach would conflate**: queue/worker throughput (what CodeFlow's own
  infrastructure can sustain) vs. execution-provider throughput (what Judge0 itself can sustain,
  quota-limited and entirely outside this project's control). A future, deliberately small
  benchmark against a real Judge0 provider (RapidAPI key or self-hosted) would measure the second
  one specifically - not attempted here.
- `load-tests/analyze-run.mjs` computes drain time, throughput, and latency percentiles **scoped to
  one run's own `userId` prefix** directly from Postgres, rather than reading the global
  `/api/v1/metrics` window - so three different concurrency runs never contaminate each other's
  numbers the way they would trying to diff two overlapping 24h windows.

### Verified (2026-09-24): 5 vs. 10 vs. 20 worker lanes

Same experiment, same 100 submissions at a constant 10 req/s arrival rate (`RATE=10
DURATION_SECONDS=10`) across 200 simulated users, only `WORKER_CONCURRENCY` changed between runs.
Real measurements, not invented:

| Lanes | Throughput | Drain time | Queue wait p50 / p95 | End-to-end p50 / p95 | Failure rate |
|---|---|---|---|---|---|
| 5  | 5.04/s | 19.83s | 7329ms / 10391ms | 7996ms / 10979ms | 0% |
| 10 | 7.56/s | 13.22s | 2523ms / 4826ms  | 3151ms / 5394ms  | 0% |
| 20 | 9.35/s | 10.70s | 1341ms / 2327ms  | 2342ms / 3360ms  | 0% |

A clean, expected saturation curve: at 5 lanes, throughput (5.04/s) can't keep up with the 10/s
arrival rate, so a backlog builds and queue wait dominates end-to-end latency (7.3s of a 8.0s
median wait is just sitting in the queue). At 20 lanes, throughput (9.35/s) nearly matches the
input rate, the backlog barely forms, and queue wait drops to a fraction of what it was - this is
precisely the "is it the queue or is it the execution provider" question Phase 9's latency split
exists to answer, now shown *changing* as a direct function of worker concurrency. `processingMs`
(worker-processing time, mock-simulated) stayed roughly flat across all three runs (~630-940ms),
confirming the bottleneck really was queue capacity, not execution time - concurrency fixed exactly
the thing it should have.

**A bonus finding, not specifically arranged**: the mock provider's small simulated failure rate
(2% server error + 1% timeout per attempt) triggered real retries under real concurrent load - 1
retry in the 5-lane run, 8 in the 10-lane run, 1 in the 20-lane run - and every single one
eventually succeeded within the 3-retry budget (0% reached `FAILED`/DLQ in any run). Phase 7's
retry logic, previously verified only in isolated single-job tests, held up correctly under
concurrent load without any special handling.

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
