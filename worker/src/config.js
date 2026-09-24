import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '../../.env') });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),
  judge0: {
    apiUrl: required('JUDGE0_API_URL'),
    apiKey: process.env.JUDGE0_API_KEY ?? '',
  },
  workerId: `worker-${os.hostname()}-${process.pid}`,
  // How long each blocking dequeue waits before giving the shutdown flag a chance to run.
  pollTimeoutSeconds: 5,
  // How long a claimed job stays "alive" without a heartbeat before the reaper considers the
  // worker dead and recovers it. Env-overridable so a demo can deliberately force a premature
  // recovery race (short lease, long heartbeat interval) without touching code.
  leaseDurationSeconds: Number(process.env.LEASE_DURATION_SECONDS ?? 15),
  // How often a worker renews the lease on the job it's currently processing.
  heartbeatIntervalSeconds: Number(process.env.HEARTBEAT_INTERVAL_SECONDS ?? 5),
  // How often the reaper sweeps for RUNNING jobs whose lease has expired.
  reaperIntervalSeconds: Number(process.env.REAPER_INTERVAL_SECONDS ?? 5),
  // How often the retry scanner sweeps for RETRYING jobs whose backoff has elapsed. Short by
  // default since backoffs themselves are short (1s/2s/4s) - a slow scan would add needless
  // latency on top of the backoff we already decided on.
  retryScanIntervalSeconds: Number(process.env.RETRY_SCAN_INTERVAL_SECONDS ?? 1),
  // How many jobs this single worker process handles concurrently. Each lane gets its own Redis
  // connection (BRPOP is blocking per-connection, so lanes can't share one and stay concurrent).
  // worker_id (the DB ownership identity) stays shared across all of a process's lanes - lanes
  // are an in-process concurrency detail, not a distinct ownership identity; the atomic
  // claim (WHERE status='QUEUED') already guarantees only one lane, in this process or any
  // other, ever ends up owning a given row.
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 3),
  // How often this worker logs a cumulative throughput/outcome summary.
  metricsLogIntervalSeconds: Number(process.env.METRICS_LOG_INTERVAL_SECONDS ?? 15),
};
