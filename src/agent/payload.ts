// Shared by the API (which starts the task) and the worker (which runs it), so it imports nothing from either.
export const AGENT_TASK_ID = "agent-turn";

/**
 * How long a turn may wait in Trigger.dev's queue before Trigger.dev drops it (it then reports the run as EXPIRED).
 * Waiting is normal when many turns arrive at once, so this is what decides that a turn was never started, not a timer
 * of our own. 10 minutes is also Trigger.dev's default for development runs.
 */
export const AGENT_QUEUE_TTL_SECONDS = 600;

/** What the agent task receives. It loads everything else (messages, history) from the database by these ids. */
export interface AgentTurnPayload {
  agentRunId: string;
  chatId: string;
  userId: string;
  assistantMessageId: string;
  traceId: string;
}
