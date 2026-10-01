import { blocksToText, foldChunks, type AgentStreamChunk, type AgentStreamMetadata, type ContentBlock } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { env } from "#src/env/worker.js";
import { loadConversation } from "#src/agent/context.js";
import { describeFailure, TurnError } from "#src/agent/outcomes.js";
import type { AgentTurnPayload } from "#src/agent/payload.js";
import { withSystemPrompt } from "#src/agent/prompt.js";
import { logger } from "#src/lib/logger.js";
import { ModelError, type ChatMessage, type ModelEvent } from "#src/lib/openrouter.js";
import { finalizeRun, toJson } from "#src/services/runs.js";

export type TurnResult = "completed" | "failed" | "cancelled" | "skipped";

/** Everything the turn needs from the outside, so it can be run (and tested) without Trigger.dev or a real model. */
export interface TurnDeps {
  stream: (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<ModelEvent>;
  /** Sends a chunk to the live stream. Must not wait and must not throw: live delivery is best effort. */
  emit: (chunk: AgentStreamChunk) => void;
  setStatus: (status: AgentStreamMetadata) => void;
  triggerRunId: string;
  /** Aborted when the run is cancelled or runs out of time. */
  signal: AbortSignal;
  now?: () => number;
  /** How often the partial reply is saved. */
  flushEveryMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The finished answer is the one thing we must not lose to a passing database problem, so saving it is tried a few times.
async function finishWithRetry(runId: string, outcome: Parameters<typeof finalizeRun>[1]): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await finalizeRun(runId, outcome);
    } catch (err) {
      if (attempt >= 3) throw err;
      logger.warn({ err, attempt }, "could not save the finished answer; trying again");
      await sleep(100 * attempt);
    }
  }
}

const withThinkingTime = (blocks: ContentBlock[], ms: number | undefined): ContentBlock[] => {
  const first = blocks.findIndex((block) => block.type === "thinking");
  if (ms === undefined || first < 0) return blocks;
  return blocks.map((block, i) => (i === first && block.type === "thinking" ? { ...block, durationMs: ms } : block));
};

/**
 * One agent turn: take the run, read the conversation, stream the model's answer to the user and to the database as it
 * is written, and end the run. It ends the run itself in every way it can; the task's hooks cover the ones it cannot.
 */
export async function runAgentTurn(payload: AgentTurnPayload, deps: TurnDeps): Promise<TurnResult> {
  const { agentRunId: runId, chatId, assistantMessageId } = payload;
  const now = deps.now ?? Date.now;
  const flushEveryMs = deps.flushEveryMs ?? 1_000;
  // live delivery is a convenience: the reply is saved to the database regardless, so it can never be allowed to fail the turn
  const emit = (chunk: AgentStreamChunk) => {
    try {
      deps.emit(chunk);
    } catch (err) {
      logger.warn({ err }, "could not send a chunk to the live stream");
    }
  };
  const setStatus = (status: AgentStreamMetadata) => {
    try {
      deps.setStatus(status);
    } catch (err) {
      logger.warn({ err }, "could not update the run's status");
    }
  };

  // Claim the run. If it is gone (chat deleted), or already ended (cancelled, undone, cleaned up), there is nothing to
  // do, and above all the model must not be called for a turn nobody is waiting for.
  const claimed = await prisma.agentRun.updateMany({
    where: { id: runId, status: "PENDING" },
    data: { status: "RUNNING", startedAt: new Date(now()), triggerRunId: deps.triggerRunId },
  });
  if (claimed.count === 0) {
    logger.warn("the run is gone or no longer pending; nothing to do");
    return "skipped";
  }
  logger.info("agent turn started");
  setStatus({ status: "thinking" });

  const controller = new AbortController();
  const stop = () => {
    setStatus({ status: "stopping" }); // the client can show "Stopping…" while what was written is saved
    controller.abort(deps.signal.reason);
  };
  if (deps.signal.aborted) stop();
  else deps.signal.addEventListener("abort", stop, { once: true });

  const chunks: AgentStreamChunk[] = [];
  let thinkingStart: number | null = null;
  let thinkingMs: number | undefined;
  const snapshot = () => withThinkingTime(foldChunks(chunks), thinkingMs);

  // Saves what has been written so far. Only while the reply is still ours (still streaming): a late save can never
  // overwrite a reply that was finished, cancelled or cleaned up in the meantime.
  const save = async (): Promise<boolean> => {
    const blocks = snapshot();
    try {
      const { count } = await prisma.message.updateMany({
        where: { id: assistantMessageId, status: "STREAMING" },
        data: { contentBlocks: toJson(blocks), content: blocksToText(blocks) },
      });
      return count === 1;
    } catch (err) {
      logger.warn({ err }, "could not save the partial reply"); // a database blip must not abort the answer
      return true;
    }
  };

  try {
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { triggerMessageId: true } });
    const history = await loadConversation(chatId, run.triggerMessageId);
    if (history.length === 0) throw new TurnError("CONTEXT_EMPTY", "I couldn't find your message. Please send it again.");
    const messages = withSystemPrompt(history, new Date(now()));

    let usage = { model: null as string | null, inputTokens: 0, outputTokens: 0 };
    let announcedAnswer = false;
    let lastSave = now();

    for await (const event of deps.stream(messages, controller.signal)) {
      if (event.type === "done") {
        usage = { model: event.model, inputTokens: event.inputTokens, outputTokens: event.outputTokens };
        continue;
      }
      if (event.type === "tool-call") continue; // no tools are offered to the model yet (the tool loop comes next)
      if (event.type === "reasoning") {
        thinkingStart ??= now();
      } else {
        if (thinkingStart !== null) thinkingMs ??= now() - thinkingStart;
        if (!announcedAnswer) {
          announcedAnswer = true;
          setStatus({ status: "working", ...(thinkingMs !== undefined && { thinkingDurationMs: thinkingMs }) });
        }
      }
      const chunk: AgentStreamChunk = event.type === "reasoning" ? { type: "thinking-delta", delta: event.delta } : { type: "text-delta", delta: event.delta };
      chunks.push(chunk);
      emit(chunk);

      if (now() - lastSave >= flushEveryMs) {
        lastSave = now();
        if (!(await save())) {
          // the reply is no longer streaming: the run was ended elsewhere (cancelled, deleted, cleaned up), so stop writing
          controller.abort();
          logger.info("the run was ended elsewhere; stopping");
          setStatus({ status: "cancelled" });
          return "cancelled";
        }
      }
    }

    if (thinkingStart !== null) thinkingMs ??= now() - thinkingStart;
    const blocks = snapshot();
    // thinking without an answer is not an answer
    if (!blocksToText(blocks).trim()) throw new ModelError("EMPTY", "the model produced no answer, only thinking", false);

    const model = usage.model ?? env.OPENROUTER_MODEL;
    const final: ContentBlock[] = [...blocks, { type: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model, creditCost: 0 }];
    const ended = await finishWithRetry(runId, { status: "COMPLETED", blocks: final, model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    // not ours to finish: the run was ended elsewhere (cancelled, deleted) just before the answer was saved
    setStatus({ status: ended ? "complete" : "cancelled" });
    logger.info({ model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }, "agent turn completed");
    return ended ? "completed" : "cancelled";
  } catch (error) {
    // Stopped from outside (a cancel, or the time limit): keep what was written and leave it to the task's hooks to say
    // which it was. Nothing here is a failure of the turn.
    if (controller.signal.aborted || deps.signal.aborted) {
      if (chunks.length > 0) await save();
      logger.info("agent turn stopped");
      setStatus({ status: "cancelled" });
      return "cancelled";
    }

    const { code, message } = describeFailure(error);
    if (error instanceof ModelError) logger.warn({ failure: error.failure, detail: error.message }, "the model could not answer");
    else if (!(error instanceof TurnError)) logger.error({ err: error }, "agent turn failed unexpectedly");

    const partial = snapshot();
    const ended = await finalizeRun(runId, { status: "FAILED", errorCode: code, errorMessage: message, ...(partial.length > 0 && { blocks: partial }) });
    setStatus(ended ? { status: "failed", error: message } : { status: "cancelled" });
    return ended ? "failed" : "cancelled";
  } finally {
    deps.signal.removeEventListener("abort", stop);
  }
}
