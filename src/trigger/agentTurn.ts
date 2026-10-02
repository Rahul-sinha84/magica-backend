import { metadata, streams, task, wait } from "@trigger.dev/sdk";
import type { AgentStreamChunk, AgentStreamMetadata } from "#src/contracts/index.js";
import { AGENT_STREAM_ID } from "#src/contracts/index.js";
import { ChunkQueue } from "#src/agent/chunkQueue.js";
import { endAfterCancel, endAfterFailure } from "#src/agent/outcomes.js";
import { AGENT_TASK_ID, type AgentTurnPayload, type MagicaToolPayload } from "#src/agent/payload.js";
import { runAgentTurn } from "#src/agent/runTurn.js";
import { prisma } from "#src/db/client.js";
import { env } from "#src/env/worker.js";
import { toolTaskKey } from "#src/lib/idempotency.js";
import { logContext, logger } from "#src/lib/logger.js";
import { streamModel } from "#src/lib/openrouter.js";
import { skills } from "#src/skills/skills.js";
import { agentTools } from "#src/tools/index.js";
import type { InvocationOutcome } from "#src/tools/magicaInvocation.js";
import { magicaToolTask } from "#src/trigger/magicaToolTask.js";
import type { WaitTokens } from "#src/waitpoints/wait.js";

// This file runs on Trigger.dev's workers, not in the API, so it must only import what the worker can load (no server
// environment, no Express, no Clerk). A test checks that.

// Read and check the agent's skills when the worker starts, so a bad skill is reported at boot, not mid-conversation.
skills();

const agentStream = streams.define<AgentStreamChunk>({ id: AGENT_STREAM_ID });

const STREAM_CLOSE_WAIT_MS = 5_000;
const setStatus = (status: AgentStreamMetadata) => {
  for (const [key, value] of Object.entries(status)) metadata.set(key, value as never);
  // a status without a running tool (or an error) must not keep showing the previous one
  if (!status.currentTool) metadata.del("currentTool");
  if (!status.error) metadata.del("error");
  // status changes are few (thinking, working, a tool starting or ending, done) and the client shows them, so they are
  // sent now rather than whenever the SDK next batches its updates
  void metadata.flush().catch((err: unknown) => logger.warn({ err }, "could not send the run's status"));
};

/**
 * Runs a step's Magica tool calls as one batch of durable child tasks, in parallel, and waits for them (Trigger.dev
 * doesn't count the wait against the turn's time limit). One child task per tool call, whatever happens: the key is
 * the run and the call. An outcome is matched back by its invocation id, not by position.
 */
async function runMagicaCalls(runId: string, calls: MagicaToolPayload[]): Promise<InvocationOutcome[]> {
  const batch = await magicaToolTask.batchTriggerAndWait(calls.map((payload) => ({ payload, options: { idempotencyKey: toolTaskKey(runId, payload.invocationId) } })));
  const byInvocation = new Map<string, InvocationOutcome>();
  for (const run of batch.runs) if (run.ok) byInvocation.set(run.output.invocationId, run.output);
  return Promise.all(
    calls.map(async ({ invocationId }) => {
      const outcome = byInvocation.get(invocationId);
      if (outcome) return outcome;
      // the child task failed for good (its failure hook ended the call and released its credits): report what it saved
      const row = await prisma.toolInvocation.findUnique({ where: { id: invocationId }, select: { status: true, errorMessage: true } });
      return { status: row?.status === "CANCELLED" ? "CANCELLED" : "FAILED", message: row?.errorMessage ?? "The tool stopped unexpectedly, so nothing was charged. Please try again." } satisfies InvocationOutcome;
    }),
  );
}

/**
 * Trigger.dev's waitpoint tokens. While a run waits on one it is suspended: it holds no worker or concurrency slot, and
 * the wait doesn't count against maxDuration.
 */
const waitTokens: WaitTokens = {
  create: async ({ idempotencyKey, timeout, tags }) => {
    const token = await wait.createToken({ idempotencyKey, timeout, tags });
    return { id: token.id };
  },
  wait: async (tokenId) => {
    const result = await wait.forToken<unknown>(tokenId);
    return result.ok ? { ok: true, output: result.output } : { ok: false };
  },
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
      // shown in the run's logs (logs written while the worker boots aren't), so the loaded skills are easy to confirm
      logger.info({ skills: skills().metadata().map((skill) => skill.name), rejected: skills().rejected().length }, "skills available");
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
          tools: { registry: agentTools, skills: skills().metadata(), runMagicaCalls: (calls) => runMagicaCalls(payload.agentRunId, calls), waitpoints: waitTokens },
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
