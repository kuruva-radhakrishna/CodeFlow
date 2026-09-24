import { Router } from 'express';
import {
  postSubmission,
  getSubmission,
  getSubmissionResult,
  listUserSubmissions,
} from '../controllers/submissionsController.js';

export const submissionsRouter = Router();

submissionsRouter.post('/submissions', postSubmission);
submissionsRouter.get('/submissions/:id', getSubmission);
submissionsRouter.get('/submissions/:id/result', getSubmissionResult);
submissionsRouter.get('/users/:userId/submissions', listUserSubmissions);
