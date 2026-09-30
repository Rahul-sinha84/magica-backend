// Every side effect of a run has a key derived from the run, so repeating any step (a retry, a duplicate hook, a
// raced cancel) applies it once.
export const holdKey = (runId: string) => `hold:${runId}`;
export const releaseKey = (runId: string) => `release:${runId}`;
export const dispatchKey = (runId: string) => `agent-run:${runId}`;
