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
- [ ] Phase 4 — worker + Judge0 integration, end-to-end execution
- [ ] Phase 5 — rate limiting
- [ ] Phase 6 — retries + worker failure handling (lease/visibility timeout)
- [ ] Phase 7 — worker concurrency + horizontal scaling
- [ ] Phase 8 — observability + metrics (queue latency, execution latency, end-to-end)
- [ ] Phase 9 — load testing (k6) at 5 / 10 / 20 workers
- [ ] Phase 10 — failure testing (Redis down, Postgres down, Judge0 timeout, worker crash)
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
signup but is rate-limited (~50 requests/day). Swap `JUDGE0_API_URL`/`JUDGE0_API_KEY` in `.env`
for a RapidAPI key or a self-hosted instance later — the worker code (Phase 4) is written against
the same Judge0 HTTP contract either way.

### API

```
POST /api/v1/submissions              create a submission (Idempotency-Key header optional) -> 202
GET  /api/v1/submissions/:id           submission state
GET  /api/v1/submissions/:id/result    execution result only
GET  /api/v1/users/:userId/submissions recent submissions for a user
GET  /api/v1/health                    liveness + DB connectivity
```

A submission now flows `QUEUED -> RUNNING -> COMPLETED` end-to-end through the real queue and a
real worker process. The worker doesn't call Judge0 yet (Phase 4) - it stubs the result so the
distribution mechanism itself is provable in isolation from execution.

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
