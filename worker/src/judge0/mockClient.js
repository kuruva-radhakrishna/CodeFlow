import { config } from '../config.js';
import { Judge0ServerError, Judge0TimeoutError } from './errors.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBase64(str) {
  return Buffer.from(str ?? '', 'utf8').toString('base64');
}

// A fake Judge0 that never makes a network call: simulates realistic execution latency and an
// occasional retryable failure, so the queue/worker/retry/metrics system can be load-tested at
// high concurrency without touching the real (quota-limited) Judge0 instance. Kept behind the
// exact same contract as the real client (worker/src/judge0/client.js) - same typed errors, same
// raw response shape (base64_encoded=true) - so normalizeJudge0Result, retry classification, and
// every downstream code path are IDENTICAL for mock and real; this is purely a substitution at
// the adapter boundary, not a parallel code path.
export async function mockSubmitToJudge0({ sourceCode }) {
  const { minLatencyMs, maxLatencyMs, serverErrorRate, timeoutRate } = config.judge0.mock;
  await sleep(minLatencyMs + Math.random() * (maxLatencyMs - minLatencyMs));

  const roll = Math.random();
  if (roll < serverErrorRate) {
    throw new Judge0ServerError(503, 'mock: simulated Judge0 server error');
  }
  if (roll < serverErrorRate + timeoutRate) {
    throw new Judge0TimeoutError();
  }

  return {
    token: `mock-${Math.random().toString(36).slice(2, 10)}`,
    status: { id: 3, description: 'Accepted' },
    stdout: toBase64(`mock output for: ${(sourceCode ?? '').slice(0, 60)}\n`),
    stderr: null,
    compile_output: null,
    time: (minLatencyMs / 1000).toFixed(3),
    memory: 3000 + Math.floor(Math.random() * 500),
  };
}
