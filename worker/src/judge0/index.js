import { config } from '../config.js';
import { submitToJudge0 as realSubmitToJudge0 } from './client.js';
import { mockSubmitToJudge0 } from './mockClient.js';

// The one place that decides real vs. mock. Everything downstream (index.js's processSubmission,
// retry classification, normalizeJudge0Result) is unaware which one it's talking to - the whole
// point of having an adapter boundary at all.
export const submitToJudge0 = config.judge0.provider === 'mock' ? mockSubmitToJudge0 : realSubmitToJudge0;

export { normalizeJudge0Result } from './result.js';
export {
  Judge0ServerError,
  Judge0NetworkError,
  Judge0TimeoutError,
  Judge0RequestError,
  isRetryableJudge0Error,
  judge0FailureReason,
} from './errors.js';
