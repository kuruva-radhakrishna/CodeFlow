// Judge0's status.id: 1=In Queue, 2=Processing (transient - not a final result),
// 3=Accepted, 4=Wrong Answer, 5=TLE, 6=Compilation Error, 7-12=Runtime Error (various signals),
// 13=Internal Error, 14=Exec Format Error. Reference: https://ce.judge0.com/statuses
//
// infraFailure=true means Judge0 itself couldn't produce a result - that's OUR problem
// (job status -> FAILED), not a verdict on the user's program (job status -> COMPLETED).
export function mapJudge0Status(statusId) {
  switch (statusId) {
    case 3:
      return { executionStatus: 'ACCEPTED', infraFailure: false };
    case 4:
      return { executionStatus: 'WRONG_ANSWER', infraFailure: false };
    case 5:
      return { executionStatus: 'TIME_LIMIT_EXCEEDED', infraFailure: false };
    case 6:
      return { executionStatus: 'COMPILATION_ERROR', infraFailure: false };
    case 7:
    case 8:
    case 9:
    case 10:
    case 11:
    case 12:
    case 14:
      return { executionStatus: 'RUNTIME_ERROR', infraFailure: false };
    case 13:
      return { executionStatus: null, infraFailure: true };
    default:
      return { executionStatus: 'OTHER', infraFailure: false };
  }
}
