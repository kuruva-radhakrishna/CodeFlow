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
- [ ] Phase 3 — Redis queue
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
```

Judge0: development currently points at the public CE instance (`ce.judge0.com`), which needs no
signup but is rate-limited (~50 requests/day). Swap `JUDGE0_API_URL`/`JUDGE0_API_KEY` in `.env`
for a RapidAPI key or a self-hosted instance later — the worker code (Phase 4) is written against
the same Judge0 HTTP contract either way.

### API

```
POST /api/v1/submissions              create a submission (Idempotency-Key header optional)
GET  /api/v1/submissions/:id           submission state
GET  /api/v1/submissions/:id/result    execution result only
GET  /api/v1/users/:userId/submissions recent submissions for a user
GET  /api/v1/health                    liveness + DB connectivity
```

Submissions are currently created with `status=QUEUED` and stay there — nothing consumes the
queue yet. That's Phase 3/4.

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
