import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { AGENT_TASK_ID, type AgentTurnPayload } from "#src/agent/payload.js";

// Stands in for src/lib/trigger.ts. It behaves like Trigger.dev where it matters: the same idempotency key always
// gives the same run, and it can be told to fail, hang, or accept a run and then report an error.
export const trigger = {
  dispatches: [] as { payload: AgentTurnPayload; key: string; triggerRunId: string }[],
  runsByKey: new Map<string, string>(),
  dispatchError: null as Error | null,
  /** Register the run, then fail anyway: the outcome the caller cannot know (a timeout after the work was accepted). */
  acceptThenFail: false,
  dispatchHangs: false,
  cancelled: [] as string[],
  cancelError: null as Error | null,
  /** What `getTriggerRunStatus` answers per Trigger.dev run id; anything not listed is a healthy, executing run. */
  statuses: new Map<string, string | null>(),
  statusLookups: [] as string[],
  tokenError: null as Error | null,
  /** Waitpoint tokens completed through the API, in order; and an error to fail the next completions with. */
  completedTokens: [] as { tokenId: string; output: Record<string, unknown> }[],
  completeTokenError: null as Error | null,
  /** Called on each completion, so a test can wake its fake waiting run (see tests/helpers/fakeTokens.ts). */
  onTokenCompleted: null as ((tokenId: string, output: Record<string, unknown>) => void) | null,
  /** While set, completing a token waits for it: holds an answer mid-way, to race another against it. */
  completeTokenGate: null as Promise<void> | null,
};

export function resetTriggerMock() {
  trigger.dispatches.length = 0;
  trigger.runsByKey.clear();
  trigger.dispatchError = null;
  trigger.acceptThenFail = false;
  trigger.dispatchHangs = false;
  trigger.cancelled.length = 0;
  trigger.cancelError = null;
  trigger.statuses.clear();
  trigger.statusLookups.length = 0;
  trigger.tokenError = null;
  trigger.completedTokens.length = 0;
  trigger.completeTokenError = null;
  trigger.onTokenCompleted = null;
  trigger.completeTokenGate = null;
}

export const triggerModule = {
  AGENT_TASK_ID,

  dispatchAgentTurn: vi.fn(async (payload: AgentTurnPayload, key: string): Promise<string> => {
    if (trigger.dispatchHangs) return new Promise<never>(() => {});
    const existing = trigger.runsByKey.get(key);
    if (existing) return existing;
    if (trigger.dispatchError && !trigger.acceptThenFail) throw trigger.dispatchError;
    const triggerRunId = `run_${randomUUID().slice(0, 12)}`;
    trigger.runsByKey.set(key, triggerRunId);
    trigger.dispatches.push({ payload, key, triggerRunId });
    if (trigger.dispatchError) throw trigger.dispatchError;
    return triggerRunId;
  }),

  cancelTriggerRun: vi.fn((triggerRunId: string): Promise<void> => {
    trigger.cancelled.push(triggerRunId); // the real one never throws, so neither does this
    return Promise.resolve();
  }),

  getTriggerRunStatus: vi.fn((triggerRunId: string): Promise<string | null> => {
    trigger.statusLookups.push(triggerRunId);
    return Promise.resolve(trigger.statuses.has(triggerRunId) ? (trigger.statuses.get(triggerRunId) ?? null) : "EXECUTING");
  }),

  completeWaitpointToken: vi.fn(async (tokenId: string, output: Record<string, unknown>): Promise<void> => {
    if (trigger.completeTokenGate) await trigger.completeTokenGate;
    if (trigger.completeTokenError) throw trigger.completeTokenError;
    trigger.completedTokens.push({ tokenId, output });
    trigger.onTokenCompleted?.(tokenId, output);
  }),

  createRealtimeToken: vi.fn((triggerRunId: string) =>
    trigger.tokenError
      ? Promise.reject(trigger.tokenError)
      : Promise.resolve({ token: `token-for-${triggerRunId}`, expiresAt: new Date(Date.now() + 60 * 60_000) }),
  ),
};
