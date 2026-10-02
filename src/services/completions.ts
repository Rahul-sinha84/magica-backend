import { blocksToText, COMPLETIONS_MODEL, COMPLETIONS_WAIT_MS, ContentBlocksSchema, V1ChatCompletionPendingSchema, V1ChatCompletionSchema, type V1ChatCompletionBody } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { AppError } from "#src/lib/errors.js";
import { logger } from "#src/lib/logger.js";
import { createChat, deleteChat } from "#src/services/chats.js";
import type { StoredResponse } from "#src/services/idempotency.js";
import { ACTIVE_STATUSES } from "#src/services/runs.js";
import { sendMessage } from "#src/services/turns.js";

// POST /v1/chat/completions, the lean way: the conversation becomes a chat (earlier messages as its history, the last
// user message sent as a normal turn), so the answer comes from the same agent, with the same credits, limits and
// records as everything else. It waits about a minute for the answer, then hands back the run to poll instead.

export interface CompletionOptions {
  traceId: string;
  waitMs?: number;
  pollMs?: number;
  /** aborted when the caller goes away: stop waiting (the run carries on) */
  signal?: AbortSignal;
}

const text = (content: V1ChatCompletionBody["messages"][number]["content"]) => (typeof content === "string" ? content : content.map((part) => part.text).join(""));

/**
 * The history to store before the question: system and developer messages folded into one leading instruction (the
 * agent has its own system prompt), then the user and assistant turns in order. Blank turns are left out.
 */
function history(messages: V1ChatCompletionBody["messages"]) {
  const instructions = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => text(m.content).trim()).filter(Boolean);
  const turns = messages
    .slice(0, -1)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role === "user" ? ("USER" as const) : ("ASSISTANT" as const), content: text(m.content) }))
    .filter((m) => m.content.trim());
  return [...(instructions.length > 0 ? [{ role: "USER" as const, content: `Instructions for this conversation:\n${instructions.join("\n\n")}` }] : []), ...turns];
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

export async function createCompletion(userId: string, body: V1ChatCompletionBody, { traceId, waitMs = COMPLETIONS_WAIT_MS, pollMs = 500, signal }: CompletionOptions): Promise<StoredResponse> {
  const question = text(body.messages.at(-1)!.content);
  if (!question.trim()) throw new AppError("VALIDATION_FAILED", "messages: The last message can't be empty.");

  const chat = await createChat(userId);
  let runId: string;
  try {
    const earlier = history(body.messages);
    const start = Date.now() - earlier.length - 1_000; // strictly before the question, in order
    for (const [i, message] of earlier.entries()) {
      await prisma.message.create({
        data: {
          chatId: chat.id,
          userId,
          role: message.role,
          status: "COMPLETED",
          content: message.content,
          contentBlocks: message.role === "ASSISTANT" ? [{ type: "text", content: message.content }] : [],
          createdAt: new Date(start + i),
        },
      });
    }
    runId = (await sendMessage({ userId, chatId: chat.id, body: { content: question, attachments: [], mode: "default" }, traceId })).runId;
  } catch (error) {
    await deleteChat(userId, chat.id).catch((err: unknown) => logger.warn({ err }, "could not remove the chat of a completion that didn't start"));
    throw error;
  }

  // wait for the answer (each look is one small query; nothing is held while waiting)
  const deadline = Date.now() + waitMs;
  let run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
  while ((ACTIVE_STATUSES as readonly string[]).includes(run.status) && Date.now() < deadline && !signal?.aborted) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
    run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
  }

  if (run.status === "COMPLETED") {
    const reply = await prisma.message.findUniqueOrThrow({ where: { id: run.assistantMessageId }, select: { contentBlocks: true, content: true } });
    const answer = blocksToText(ContentBlocksSchema.parse(Array.isArray(reply.contentBlocks) ? reply.contentBlocks : [])) || reply.content || "";
    const prompt = run.inputTokens ?? 0;
    const completion = run.outputTokens ?? 0;
    return {
      status: 200,
      body: V1ChatCompletionSchema.parse({
        id: `chatcmpl_${run.id}`,
        object: "chat.completion",
        created: Math.floor((run.completedAt ?? new Date()).getTime() / 1000),
        model: run.model ?? COMPLETIONS_MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: answer.trim() }, finish_reason: "stop" }],
        usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
        run_id: run.id,
      }),
    };
  }
  if (run.status === "FAILED" || run.status === "CANCELLED") {
    throw new AppError("SERVICE_UNAVAILABLE", run.errorMessage ?? "The answer couldn't be completed. Please try again.", { runId: run.id, reason: run.errorCode ?? run.status });
  }
  const waiting = run.status === "RUNNING" && (await prisma.waitpoint.count({ where: { agentRunId: run.id, status: "PENDING" } })) > 0;
  return {
    status: 202,
    body: V1ChatCompletionPendingSchema.parse({ object: "chat.completion.pending", run_id: run.id, chat_id: chat.id, status: run.status === "PENDING" ? "queued" : waiting ? "waiting" : "running" }),
  };
}
