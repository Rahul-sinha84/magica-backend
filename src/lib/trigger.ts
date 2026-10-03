import { auth, configure, runs, tasks, wait } from "@trigger.dev/sdk";
import { AGENT_QUEUE_TTL_SECONDS, AGENT_TASK_ID, MAGICA_TOOL_TASK_ID, type AgentTurnPayload, type MagicaToolPayload } from "#src/agent/payload.js";
import { env } from "#src/env/server.js";
import { logger } from "#src/lib/logger.js";

// The only file on the API side that talks to Trigger.dev, so tests can replace it with one module mock.

configure({ secretKey: env.TRIGGER_SECRET_KEY });

const TOKEN_TTL_MS = 60 * 60_000;
const CALL_TIMEOUT_MS = 8_000;

export { AGENT_TASK_ID, type AgentTurnPayload };

async function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${CALL_TIMEOUT_MS} ms`)), CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts the agent task and returns its Trigger.dev run id. The same key always maps to the same run. The caller
 * decides how long to wait (see `sendMessage`), because what to do about a slow answer is its call.
 */
export async function dispatchAgentTurn(payload: AgentTurnPayload, idempotencyKey: string): Promise<string> {
  const handle = await tasks.trigger(AGENT_TASK_ID, payload, {
    idempotencyKey,
    ttl: AGENT_QUEUE_TTL_SECONDS, // a turn nobody starts in time is dropped by Trigger.dev and reported as EXPIRED
    tags: [`chat_${payload.chatId}`, `user_${payload.userId}`],
  });
  return handle.id;
}

/**
 * Starts a standalone Magica tool run (the public API's /v1/tools) and returns its Trigger.dev run id. The same key
 * always maps to the same run. Dropped by Trigger.dev if nobody starts it within the agent's queue TTL.
 */
export async function dispatchToolRun(payload: MagicaToolPayload, idempotencyKey: string): Promise<string> {
  const handle = await withTimeout(
    tasks.trigger(MAGICA_TOOL_TASK_ID, payload, { idempotencyKey, ttl: AGENT_QUEUE_TTL_SECONDS, tags: [`user_${payload.userId}`, "standalone"] }),
    "starting the tool run",
  );
  return handle.id;
}

/** Best effort: the database is the source of truth, so a failure to reach Trigger.dev is logged, never thrown. */
export async function cancelTriggerRun(triggerRunId: string): Promise<void> {
  try {
    await withTimeout(runs.cancel(triggerRunId), "cancelling the agent run");
  } catch (err) {
    logger.warn({ err, triggerRunId }, "could not cancel the Trigger.dev run (it may already be over)");
  }
}

/** The run's real status as Trigger.dev sees it, or null when it cannot be determined right now. */
export async function getTriggerRunStatus(triggerRunId: string): Promise<string | null> {
  try {
    return (await withTimeout(runs.retrieve(triggerRunId), "looking up the agent run")).status;
  } catch (err) {
    logger.warn({ err, triggerRunId }, "could not look up the Trigger.dev run");
    return null;
  }
}

/** Wakes a run waiting on this waitpoint token, handing it `output` (the user's answer). Throws if Trigger.dev can't be reached. */
export async function completeWaitpointToken(tokenId: string, output: Record<string, unknown>): Promise<void> {
  await withTimeout(wait.completeToken(tokenId, output), "answering the waitpoint");
}

/** A read-only token that lets the browser follow this one run (status and streamed text), for an hour. */
export async function createRealtimeToken(triggerRunId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = await auth.createPublicToken({ scopes: { read: { runs: [triggerRunId] } }, expirationTime: "1h" });
  return { token, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) };
}
