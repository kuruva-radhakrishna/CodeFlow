import { redis } from '../queue/client.js';
import { config } from '../config/index.js';

const WINDOW_SECONDS = 60;
export const RATE_LIMITED_TOTAL_KEY = 'codeflow:metrics:rate_limited_total';

// Fixed-window counter, explicit on purpose (the user's plan preferred an explicit algorithm we
// can name over a smarter one we can't reason about yet - a token bucket would smooth bursts
// better, but that's a deliberate future upgrade, not a gap). Redis INCR is atomic, so concurrent
// requests in the same window can't undercount each other.
export async function checkRateLimit(userId) {
  const windowKey = `codeflow:ratelimit:${userId}:${Math.floor(Date.now() / (WINDOW_SECONDS * 1000))}`;
  const count = await redis.incr(windowKey);
  if (count === 1) {
    await redis.expire(windowKey, WINDOW_SECONDS);
  }
  const allowed = count <= config.rateLimitPerMinute;
  if (!allowed) {
    // Rejected requests leave zero trace in Postgres/Redis job state by design (Phase 6) - this
    // is the one exception, a cumulative counter purely for observability, not admission logic.
    await redis.incr(RATE_LIMITED_TOTAL_KEY);
  }
  return { allowed, count, limit: config.rateLimitPerMinute };
}
