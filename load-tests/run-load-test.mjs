// Node-based load generator (k6 wasn't reliably installable in this environment - no admin
// rights, and another external-binary install saga wasn't worth it given a Node-native harness
// measures the exact same thing: request rate and submit-latency against the real API).
//
// Fires POST /submissions at a constant arrival rate (fire-and-forget per tick, not awaited
// before the next one - the same executor model as k6's constant-arrival-rate), spread across
// many distinct simulated userIds so per-user rate limiting doesn't confound a queue/system
// throughput test with admission-control behavior.
//
// Usage: RATE=10 DURATION_SECONDS=10 RUN_ID=run1 node load-tests/run-load-test.mjs
import { setTimeout as sleep } from 'node:timers/promises';

const RATE = Number(process.env.RATE ?? 10); // requests per second
const DURATION_SECONDS = Number(process.env.DURATION_SECONDS ?? 10);
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN_ID = process.env.RUN_ID ?? Date.now().toString(36);
const SIMULATED_USERS = Number(process.env.SIMULATED_USERS ?? 200);

const totalRequests = RATE * DURATION_SECONDS;
const intervalMs = 1000 / RATE;

let sent = 0;
let succeeded = 0;
let rateLimited = 0;
let failed = 0;
const submitLatenciesMs = [];

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function fireOne(i) {
  const userId = `loadtest-${RUN_ID}-user-${i % SIMULATED_USERS}`;
  const body = JSON.stringify({ userId, languageId: 71, sourceCode: `print(${i})`, stdin: '' });
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/v1/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `${RUN_ID}-${i}` },
      body,
    });
    submitLatenciesMs.push(Date.now() - start);
    if (res.status === 202) succeeded++;
    else if (res.status === 429) rateLimited++;
    else failed++;
  } catch {
    failed++;
  }
}

async function main() {
  console.log(`[${RUN_ID}] sending ${totalRequests} requests at ${RATE}/s for ${DURATION_SECONDS}s across ${SIMULATED_USERS} simulated users`);

  for (let i = 0; i < totalRequests; i++) {
    fireOne(i); // fire-and-forget: constant arrival rate, not concurrency-limited
    sent++;
    await sleep(intervalMs);
  }

  // let in-flight requests settle before reporting
  await sleep(2000);

  const report = {
    runId: RUN_ID,
    sent,
    succeeded,
    rateLimited,
    failed,
    submitLatencyMs: {
      p50: percentile(submitLatenciesMs, 50),
      p95: percentile(submitLatenciesMs, 95),
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

main();
