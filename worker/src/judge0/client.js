import { config } from '../config.js';

const MAX_POLL_ATTEMPTS = 5;

function headers() {
  return {
    'Content-Type': 'application/json',
    ...(config.judge0.apiKey ? { 'X-RapidAPI-Key': config.judge0.apiKey } : {}),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBase64(str) {
  return Buffer.from(str ?? '', 'utf8').toString('base64');
}

// base64_encoded=true for both directions: Judge0's plain-text mode (base64_encoded=false)
// rejects some otherwise-valid submissions as "cannot be converted to UTF-8" (observed with
// plain ASCII C++ source), and base64 is what Judge0 itself recommends to avoid that whole class
// of transport issue. wait=true asks Judge0 to block server-side until the submission finishes,
// so the common case is exactly one HTTP request - that matters on the public CE instance's tight
// daily quota. Some public deployments cap or ignore wait=true under load, so we fall back to a
// short bounded poll (still just a handful of requests, not a real poll loop).
export async function submitToJudge0({ languageId, sourceCode, stdin }) {
  const submitRes = await fetch(`${config.judge0.apiUrl}/submissions?base64_encoded=true&wait=true`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      language_id: languageId,
      source_code: toBase64(sourceCode),
      stdin: toBase64(stdin),
    }),
  });
  if (!submitRes.ok) {
    throw new Error(`Judge0 submit failed: ${submitRes.status} ${await submitRes.text()}`);
  }

  let result = await submitRes.json();
  let attempts = 0;
  while (result.status && result.status.id <= 2 && attempts < MAX_POLL_ATTEMPTS) {
    await sleep(1000 * (attempts + 1));
    const pollRes = await fetch(`${config.judge0.apiUrl}/submissions/${result.token}?base64_encoded=true`, {
      headers: headers(),
    });
    if (!pollRes.ok) {
      throw new Error(`Judge0 poll failed: ${pollRes.status} ${await pollRes.text()}`);
    }
    result = await pollRes.json();
    attempts += 1;
  }

  return result;
}
