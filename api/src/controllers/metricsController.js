import { getMetricsSnapshot } from '../services/metrics.js';

export async function getMetrics(req, res, next) {
  try {
    const snapshot = await getMetricsSnapshot();
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
}
