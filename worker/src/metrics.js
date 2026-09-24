// Deliberately minimal - in-memory counters + a periodic log line, not a metrics server or a
// Prometheus exporter (that's a real future upgrade, not required yet). This just gives us enough
// to see a process is making progress, compare throughput across configurations, and (via
// publishSnapshot) let the API's /metrics endpoint see which workers are currently alive.
export const WORKER_METRICS_KEY_PREFIX = 'codeflow:worker-metrics:';

export function createMetrics() {
  const counts = { claimed: 0, completed: 0, failed: 0, retried: 0, discarded: 0 };
  const startedAt = Date.now();

  return {
    increment(key) {
      counts[key] = (counts[key] ?? 0) + 1;
    },
    snapshot() {
      const uptimeSeconds = (Date.now() - startedAt) / 1000;
      return {
        ...counts,
        uptimeSeconds: Number(uptimeSeconds.toFixed(1)),
        completedPerSecond: uptimeSeconds > 0 ? Number((counts.completed / uptimeSeconds).toFixed(3)) : 0,
      };
    },
  };
}

// Publishes this worker's current snapshot to Redis with a short TTL, refreshed on every call -
// a dead worker's entry simply expires on its own a few seconds after it stops publishing, the
// same self-expiring pattern as the submission lease, so the API never needs to explicitly clean
// up entries for workers that crashed.
export async function publishSnapshot(redis, workerId, snapshot, ttlSeconds) {
  const key = `${WORKER_METRICS_KEY_PREFIX}${workerId}`;
  await redis.hset(key, {
    workerId,
    ...snapshot,
    updatedAt: new Date().toISOString(),
  });
  await redis.expire(key, ttlSeconds);
}
