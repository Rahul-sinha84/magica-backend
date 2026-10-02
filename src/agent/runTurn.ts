import { blocksToText, foldChunks, type AgentStreamChunk, type AgentStreamMetadata, type ContentBlock } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { env } from "#src/env/worker.js";
import { loadConversation } from "#src/agent/context.js";
import { describeFailure, TurnError } from "#src/agent/outcomes.js";
import type { AgentTurnPayload, MagicaToolPayload } from "#src/agent/payload.js";
import { withSystemPrompt, type PromptTools } from "#src/agent/prompt.js";
import { linksIn, runToolStep } from "#src/agent/toolStep.js";
import { logger } from "#src/lib/logger.js";
import { ModelError, type ChatMessage, type ModelEvent, type StreamCallOptions, type ToolCallEvent } from "#src/lib/openrouter.js";
import { finalizeRun, toJson } from "#src/services/runs.js";
import { turnToolCost } from "#src/services/toolInvocations.js";
import type { InvocationOutcome } from "#src/tools/magicaInvocation.js";
import type { ToolDefinition, ToolRegistry } from "#src/tools/registry.js";
import { PROPOSE_PLAN } from "#src/tools/planTools.js";
import { createWaiter, planApproved, type WaitTokens } from "#src/waitpoints/wait.js";

export type TurnResult = "completed" | "failed" | "cancelled" | "skipped";

/** Everything the turn needs from the outside, so it can be run (and tested) without Trigger.dev or a real model. */
export interface TurnDeps {
  stream: (messages: ChatMessage[], signal: AbortSignal, options?: StreamCallOptions) => AsyncIterable<ModelEvent>;
  /** What the agent may use. Without it the turn is text only. */
  tools?: TurnTools;
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

export interface TurnTools {
  registry: ToolRegistry;
  skills: { name: string; description: string }[];
  /** Runs a step's Magica calls as durable child tasks, in parallel; outcomes in the same order. */
  runMagicaCalls: (calls: MagicaToolPayload[]) => Promise<InvocationOutcome[]>;
  /** Model calls allowed in one turn. */
  maxSteps?: number;
  /** Waitpoint tokens, for pausing until the user answers (plan approval, spend approval). Without them the turn can't wait. */
  waitpoints?: WaitTokens;
}

/** A turn may call the model at most this many times (each step may use tools); then it stops with what it has. */
export const MAX_STEPS = 10;

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

/**
 * The lines the history uses to tell the model about media: what was generated ("[Generated image: https://…]") and
 * what the user attached ("[Attached video: https://…]", "[Attached image (expired)]"). Models sometimes copy them
 * into their answer; the user already sees the media, so they are removed.
 */
const MEDIA_PLACEHOLDER = /[ \t]*\[(?:Generated|Attached) (?:image|video|audio)(?:: [^\]\s]+| \(expired\))\][ \t]*/g;

/**
 * Models sometimes copy those lines into their answer, which would show users a raw link (the media itself is already
 * shown). They are removed from the reply's text before it is saved.
 */
export function withoutMediaPlaceholders(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.flatMap((block) => {
    if (block.type !== "text" || !MEDIA_PLACEHOLDER.test(block.content)) return [block];
    MEDIA_PLACEHOLDER.lastIndex = 0;
    // between two words a removed placeholder leaves one space, so they don't run together; elsewhere it leaves nothing
    const content = block.content
      .replace(MEDIA_PLACEHOLDER, (match: string, offset: number, text: string) => {
        const before = text[offset - 1];
        const after = text[offset + match.length];
        return before !== undefined && after !== undefined && before !== "\n" && after !== "\n" ? " " : "";
      })
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return content ? [{ ...block, content }] : [];
  });
}

/**
 * The tools a step may not run, and why (the model reads the reason and can act on it). In plan mode nothing that costs
 * credits runs before the user has approved a plan, and only one plan is proposed at a time; outside plan mode there
 * are no plans to propose. A new set of rules per step: it remembers the plan proposed earlier in the same step.
 */
function turnRules(planMode: boolean, approved: boolean): (tool: ToolDefinition) => string | null {
  let proposed = false;
  return (tool) => {
    if (tool.name === PROPOSE_PLAN) {
      if (!planMode) return "propose_plan is only for plan mode. Do what the user asked directly.";
      if (proposed) return "Propose one plan at a time, and wait for the answer to it.";
      proposed = true;
      return null;
    }
    if (planMode && !approved && tool.creditCost > 0) {
      return `Plan mode: propose a plan with propose_plan and wait for the user to approve it before using ${tool.name}.`;
    }
    return null;
  };
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
  const snapshot = () => withThinkingTime(withoutMediaPlaceholders(foldChunks(chunks)), thinkingMs);

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
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { triggerMessageId: true, mode: true } });
    const planMode = run.mode === "PLAN";
    const history = await loadConversation(chatId, run.triggerMessageId);
    if (history.length === 0) throw new TurnError("CONTEXT_EMPTY", "I couldn't find your message. Please send it again.");
    const tools = deps.tools;
    // propose_plan is only offered in plan mode
    const offered = (tools?.registry.functions() ?? []).filter((tool) => planMode || tool.function.name !== PROPOSE_PLAN);
    const promptTools: PromptTools | undefined = tools && { skills: tools.skills, tools: offered.map((t) => ({ name: t.function.name, description: t.function.description })) };
    const messages: ChatMessage[] = withSystemPrompt(history, new Date(now()), promptTools, planMode ? "plan" : "default");
    // the only links a tool may use: ones that appear in the conversation, plus media the turn itself creates
    const knownUrls = new Set(history.flatMap((message) => linksIn(message.content)));
    const maxSteps = tools?.maxSteps ?? MAX_STEPS;
    const waiter =
      tools?.waitpoints &&
      createWaiter({
        runId,
        tokens: tools.waitpoints,
        emit: (chunk) => {
          chunks.push(chunk);
          emit(chunk);
        },
        checkpoint: async () => {
          lastSave = now();
          return save();
        },
        setStatus,
        now,
        log: logger,
        signal: controller.signal,
      });

    const usage = { model: null as string | null, inputTokens: 0, outputTokens: 0 };
    let announcedAnswer = false;
    let usedTools = false;
    let lastSave = now();
    const endedElsewhere = () => {
      // the reply is no longer streaming: the run was ended elsewhere (cancelled, deleted, cleaned up), so stop writing
      controller.abort();
      logger.info("the run was ended elsewhere; stopping");
      setStatus({ status: "cancelled" });
      return "cancelled" as const;
    };
    const record = async (chunk: AgentStreamChunk) => {
      chunks.push(chunk);
      emit(chunk);
      if (now() - lastSave >= flushEveryMs) {
        lastSave = now();
        return save();
      }
      return true;
    };

    for (let step = 1; ; step++) {
      let stepText = "";
      const calls: ToolCallEvent[] = [];
      try {
        for await (const event of deps.stream(messages, controller.signal, tools ? { tools: offered } : undefined)) {
          if (event.type === "done") {
            // each step may be answered by a different free model: tokens add up, and the last model is recorded
            usage.model = event.model ?? usage.model;
            usage.inputTokens += event.inputTokens;
            usage.outputTokens += event.outputTokens;
            continue;
          }
          if (event.type === "tool-call") {
            calls.push(event);
            continue;
          }
          if (event.type === "reasoning") {
            thinkingStart ??= now();
          } else {
            if (thinkingStart !== null) thinkingMs ??= now() - thinkingStart;
            stepText += event.delta;
            if (!announcedAnswer) {
              announcedAnswer = true;
              setStatus({ status: "working", ...(thinkingMs !== undefined && { thinkingDurationMs: thinkingMs }) });
            }
          }
          const chunk: AgentStreamChunk = event.type === "reasoning" ? { type: "thinking-delta", delta: event.delta } : { type: "text-delta", delta: event.delta };
          if (!(await record(chunk))) return endedElsewhere();
        }
        // the model's first thinking ends with its step, whether the step ends in text or in tool calls: time spent
        // running tools (or waiting for them) is not thinking
        if (thinkingStart !== null) thinkingMs ??= now() - thinkingStart;
      } catch (error) {
        // After tools, free models often reply with nothing at all (the client reports that as an empty answer once its
        // retries are spent). The tools' results are the answer then: the turn completes on them rather than failing.
        if (usedTools && error instanceof ModelError && error.failure === "EMPTY") {
          logger.info({ step }, "the model added nothing after its tools; the turn ends on their results");
          break;
        }
        throw error;
      }

      if (!tools || calls.length === 0) break; // the model answered: the turn is done
      if (step >= maxSteps) {
        logger.warn({ step, pendingCalls: calls.map((c) => c.name) }, "the agent reached its step limit");
        throw new TurnError("AGENT_MAX_STEPS", "The agent reached its step limit before finishing. What it did so far is kept.");
      }

      usedTools = true;
      const refuse = turnRules(planMode, planMode && (await planApproved(runId)));
      const result = await runToolStep(calls, {
        registry: tools.registry,
        runMagicaCalls: tools.runMagicaCalls,
        agentRunId: runId,
        chatId,
        userId: payload.userId,
        traceId: payload.traceId,
        log: logger,
        signal: controller.signal,
        knownUrls,
        emit: (chunk) => {
          chunks.push(chunk);
          emit(chunk);
        },
        setStatus,
        now,
        step,
        checkpoint: async () => {
          lastSave = now();
          await save();
        },
        ...(waiter && { waitFor: waiter }),
        refuse,
      });
      if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("stopped", "AbortError");
      lastSave = now();
      if (!(await save())) return endedElsewhere(); // tool results are worth keeping straight away (a reload shows them)
      if (result.outOfCredits) throw new TurnError("INSUFFICIENT_CREDITS", "You ran out of credits, so the agent stopped. What it finished is kept.");
      messages.push(
        { role: "assistant", content: stepText || null, tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })) },
        ...result.messages,
      );
    }

    if (thinkingStart !== null) thinkingMs ??= now() - thinkingStart;
    const blocks = snapshot();
    // thinking without an answer is not an answer (a turn that used tools may end on their results alone)
    if (!usedTools && !blocksToText(blocks).trim()) throw new ModelError("EMPTY", "the model produced no answer, only thinking", false);

    const model = usage.model ?? env.OPENROUTER_MODEL;
    const creditCost = usedTools ? await turnToolCost(runId) : 0;
    const final: ContentBlock[] = [...blocks, { type: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model, creditCost }];
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
