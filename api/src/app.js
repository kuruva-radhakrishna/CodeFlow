import express from 'express';
import cors from 'cors';
import { submissionsRouter } from './routes/submissions.js';
import { getMetrics } from './controllers/metricsController.js';
import { errorHandler } from './middleware/errorHandler.js';
import { pool } from './db/pool.js';

export const app = express();

// Any origin is the correct scope, not a shortcut - this is a public read-mostly demo API with no
// cookies/session auth to protect. Using the standard `cors` package (not hand-rolled headers) -
// a hand-rolled version worked locally but mysteriously never took effect once deployed on
// Render, for reasons not fully root-caused; the well-tested package is the safer choice
// regardless of the exact cause.
app.use(cors());

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
