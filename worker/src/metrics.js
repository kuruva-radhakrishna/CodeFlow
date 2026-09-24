// Deliberately minimal - in-memory counters + a periodic log line, not a metrics server or a
// Prometheus exporter. That's Phase 9's job; this just gives us enough to see this process is
// making progress and to compare throughput across concurrency levels while testing Phase 8.
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
