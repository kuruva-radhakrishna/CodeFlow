import express from 'express';
import { submissionsRouter } from './routes/submissions.js';
import { getMetrics } from './controllers/metricsController.js';
import { errorHandler } from './middleware/errorHandler.js';
import { pool } from './db/pool.js';

export const app = express();

app.use(express.json());

app.get('/api/v1/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok' });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'unreachable' });
  }
});

app.get('/api/v1/metrics', getMetrics);

app.use('/api/v1', submissionsRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

app.use(errorHandler);
