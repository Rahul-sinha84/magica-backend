import { task } from "@trigger.dev/sdk";
import { MAGICA_TOOL_TASK_ID, type MagicaToolPayload } from "#src/agent/payload.js";
import { magica } from "#src/lib/magica.js";
import { logContext, logger } from "#src/lib/logger.js";
import { endInvocation } from "#src/services/toolInvocations.js";
import { agentTools } from "#src/tools/index.js";
import { runMagicaInvocation, type InvocationOutcome } from "#src/tools/magicaInvocation.js";

// One Magica tool call as its own durable task, started by the agent turn (one task per tool call: its idempotency
// key is the run and tool call). Waiting for Magica happens here, not in the turn.

export const magicaToolTask = task({
  id: MAGICA_TOOL_TASK_ID,
  // Magica runs are given 5 minutes; this leaves room to start, resume and settle
  maxDuration: 420,
  // A second attempt only happens after the first one died. It is safe: a finished call answers from the database, a
  // started run is resumed, and a call that may have reached Magica is never sent again.
  retry: { maxAttempts: 2 },

  run: async (payload: MagicaToolPayload, { signal }): Promise<InvocationOutcome> => {
    const context = { traceId: payload.traceId, userId: payload.userId, chatId: payload.chatId, runId: payload.agentRunId };
    return logContext.run(context, async () => runMagicaInvocation(payload.invocationId, { client: await magica(), registry: agentTools, log: logger, signal }));
  },

  // the task died or ran out of time (its own code ends the call in every other case): end it and give the credits back
  onFailure: async ({ payload }: { payload: MagicaToolPayload }) => {
    await endInvocation(payload.invocationId, "FAILED", "The tool stopped unexpectedly, so nothing was charged. Please try again.");
  },
  onCancel: async ({ payload }: { payload: MagicaToolPayload }) => {
    await endInvocation(payload.invocationId, "CANCELLED", "Stopped.");
  },
});
