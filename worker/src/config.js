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
};
