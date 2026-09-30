// Shared by the API (which starts the task) and the worker (which runs it), so it imports nothing from either.
export const AGENT_TASK_ID = "agent-turn";

/** What the agent task receives. It loads everything else (messages, history) from the database by these ids. */
export interface AgentTurnPayload {
  agentRunId: string;
  chatId: string;
  userId: string;
  assistantMessageId: string;
  traceId: string;
}
