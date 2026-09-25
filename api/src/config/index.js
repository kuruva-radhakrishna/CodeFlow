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
  // Render (and most PaaS) inject PORT themselves and expect the app to honor it, so that always
  // wins when present. Locally, the port lives in API_PORT (not PORT) - api/ and worker/ share
  // one root .env, and the worker also reacts to a bare PORT (for its own optional health server
  // on platforms that need one) - naming the API's port distinctly means the two processes can
  // never end up fighting over the same port when run side by side locally.
  port: Number(process.env.PORT ?? process.env.API_PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),
  // The API never talks to Judge0 (only the worker does) - it has no business requiring a
  // Judge0 env var just to boot.
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 5),
};
