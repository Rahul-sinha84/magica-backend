import { TurnError } from "#src/agent/turnError.js";
import { FAILURE_INFO, ModelError } from "#src/lib/openrouter.js";
import { finalizeRun } from "#src/services/runs.js";

export { TurnError };

const GENERIC = { code: "AGENT_ERROR", message: "The agent ran into a problem. Please try again." };
const TIMEOUT = { code: "AGENT_TIMEOUT", message: "The agent took too long. Please try again." };

/** Turns anything that went wrong into a stable code and a message that is safe to show. Never exposes internals. */
export function describeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ModelError) return FAILURE_INFO[error.failure];
  if (error instanceof TurnError) return { code: error.code, message: error.safeMessage };
  if (error instanceof Error && /max.?duration|timed.?out|time limit/i.test(error.message)) return TIMEOUT;
  return GENERIC;
}

// What the task's own failure and cancel hooks do. The turn normally ends itself; these make sure a run is ended even if
// it could not (the worker was stopped, it crashed, it ran out of time). Both are harmless if the run already ended.

export async function endAfterFailure(runId: string, error: unknown): Promise<void> {
  const { code, message } = describeFailure(error);
  await finalizeRun(runId, { status: "FAILED", errorCode: code, errorMessage: message });
}

export async function endAfterCancel(runId: string): Promise<void> {
  await finalizeRun(runId, { status: "CANCELLED" });
}
