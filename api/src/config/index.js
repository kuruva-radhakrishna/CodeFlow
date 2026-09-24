import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Load the repo-root .env regardless of which workspace's cwd this runs from
// (npm workspace scripts set cwd to the package dir, e.g. api/).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '../../../.env') });

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),
  judge0: {
    apiUrl: required('JUDGE0_API_URL'),
    apiKey: process.env.JUDGE0_API_KEY ?? '',
  },
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 5),
};
