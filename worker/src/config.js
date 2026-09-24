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
  workerId: `worker-${os.hostname()}-${process.pid}`,
  // How long each blocking dequeue waits before giving the shutdown flag a chance to run.
  pollTimeoutSeconds: 5,
};
