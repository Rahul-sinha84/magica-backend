// Every side effect of a run has a key derived from the run, so repeating any step (a retry, a duplicate hook, a
// raced cancel) applies it once.
export const holdKey = (runId: string) => `hold:${runId}`;
export const releaseKey = (runId: string) => `release:${runId}`;
export const dispatchKey = (runId: string) => `agent-run:${runId}`;
// tool calls: credits reserved before the call, then either charged or released, each exactly once
export const toolHoldKey = (invocationId: string) => `tool-hold:${invocationId}`;
export const toolReleaseKey = (invocationId: string) => `tool-release:${invocationId}`;
export const toolChargeKey = (invocationId: string) => `tool-charge:${invocationId}`;
/** Trigger.dev's idempotency key for a tool call's child task: one task per tool call, however often it is asked for. */
export const toolTaskKey = (runId: string, toolCallId: string) => `tool:${runId}:${toolCallId}`;
