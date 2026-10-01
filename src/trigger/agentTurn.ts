import { metadata, streams, task } from "@trigger.dev/sdk";
import type { AgentStreamChunk, AgentStreamMetadata } from "#src/contracts/index.js";
import { AGENT_STREAM_ID } from "#src/contracts/index.js";
import { ChunkQueue } from "#src/agent/chunkQueue.js";
import { endAfterCancel, endAfterFailure } from "#src/agent/outcomes.js";
import { AGENT_TASK_ID, type AgentTurnPayload } from "#src/agent/payload.js";
import { runAgentTurn } from "#src/agent/runTurn.js";
import { env } from "#src/env/worker.js";
import { logContext, logger } from "#src/lib/logger.js";
import { streamModel } from "#src/lib/openrouter.js";

// This file runs on Trigger.dev's workers, not in the API, so it must only import what the worker can load (no server
// environment, no Express, no Clerk). A test checks that.

const agentStream = streams.define<AgentStreamChunk>({ id: AGENT_STREAM_ID });

const STREAM_CLOSE_WAIT_MS = 5_000;
const setStatus = (status: AgentStreamMetadata) => {
  for (const [key, value] of Object.entries(status)) metadata.set(key, value as never);
};

export const agentTurn = task({
  id: AGENT_TASK_ID,
  // a turn must never run past this (the API's stale-run rule assumes it), and it is never retried: a retry would
  // call the model a second time for a reply the user may already be reading
  maxDuration: 600,
  retry: { maxAttempts: 1 },
  // the free model is rate limited, so a burst waits in the queue instead of everyone hitting it at once
  queue: { concurrencyLimit: env.AGENT_CONCURRENCY_LIMIT },

  run: async (payload: AgentTurnPayload, { ctx, signal }) => {
    const context = { traceId: payload.traceId, userId: payload.userId, chatId: payload.chatId, runId: payload.agentRunId, messageId: payload.assistantMessageId };
    return logContext.run(context, async () => {
      const queue = new ChunkQueue<AgentStreamChunk>();
      const delivered = agentStream
        .pipe(queue, { signal })
        .waitUntilComplete()
        .catch((err: unknown) => logger.warn({ err }, "live streaming failed; the reply is still being saved"));
      try {
        const result = await runAgentTurn(payload, {
          stream: streamModel,
          emit: (chunk) => queue.push(chunk),
          setStatus,
          triggerRunId: ctx.run.id,
          signal,
        });
        return { result };
      } finally {
        queue.end();
        await Promise.race([delivered, new Promise((resolve) => setTimeout(resolve, STREAM_CLOSE_WAIT_MS))]);
      }
    });
  },

  // the turn ends its own run in every way it can; these cover the ways it cannot (a stopped worker, a crash, a time limit)
  onFailure: async ({ payload, error }) => {
    await logContext.run({ traceId: payload.traceId, runId: payload.agentRunId }, () => endAfterFailure(payload.agentRunId, error));
  },
  onCancel: async ({ payload }) => {
    await logContext.run({ traceId: payload.traceId, runId: payload.agentRunId }, () => endAfterCancel(payload.agentRunId));
  },
});
