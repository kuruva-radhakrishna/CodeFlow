import { mapJudge0Status } from './mapStatus.js';

function fromBase64(str) {
  if (str == null) return null;
  return Buffer.from(str, 'base64').toString('utf8');
}

export function normalizeJudge0Result(raw) {
  const { executionStatus, infraFailure } = mapJudge0Status(raw.status?.id);
  return {
    infraFailure,
    executionStatus,
    statusDescription: raw.status?.description ?? null,
    stdout: fromBase64(raw.stdout),
    stderr: fromBase64(raw.stderr),
    compileOutput: fromBase64(raw.compile_output),
    executionTime: raw.time != null ? Number(raw.time) : null,
    memoryUsed: raw.memory != null ? Number(raw.memory) : null,
    judge0Token: raw.token ?? null,
  };
}
