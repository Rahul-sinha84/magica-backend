import type { SendMessageBody, Message } from "#src/contracts/index.js";
import { prisma, Prisma } from "#src/db/client.js";
import { env } from "#src/env/server.js";
import { AppError, constraintOf } from "#src/lib/errors.js";
import { dispatchKey, holdKey } from "#src/lib/idempotency.js";
import { logger } from "#src/lib/logger.js";
import { wellFormed } from "#src/lib/text.js";
import { DEFAULT_CHAT_TITLE, titleFrom } from "#src/lib/title.js";
import { createRealtimeToken, dispatchAgentTurn } from "#src/lib/trigger.js";
import { hold } from "#src/services/credits.js";
import { reconcileChat, reconcileUserRuns } from "#src/services/reconcile.js";
import { requireChat } from "#src/services/chats.js";
import { ACTIVE_STATUSES, RETRYABLE_STATUSES, finalizeRun } from "#src/services/runs.js";
import { serializeMessage } from "#src/services/serialize.js";

const PROVISIONAL_TITLE_MAX = 50;
const DISPATCH_TIMEOUT_MS = 8_000;
const REPLAY_WAIT_MS = 2_000;

export interface SentTurn {
  replayed: boolean;
  message: Message;
  runId: string;
  triggerRunId: string;
}

export interface SendOptions {
  dispatchTimeoutMs?: number;
  replayWaitMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const violates = (error: unknown, constraint: string) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && constraintOf(error) === constraint;

const runActive = () => new AppError("RUN_ACTIVE", "An agent is already running in this chat.");

/** A reply to a send that was already accepted: the same turn, never a second one. Null when there is no such turn. */
async function replay(chatId: string, body: SendMessageBody, replayWaitMs: number): Promise<SentTurn | null> {
  if (!body.clientMessageId) return null;
  const find = () =>
    prisma.message.findFirst({
      where: { chatId, clientMessageId: body.clientMessageId },
      include: { triggeredRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, triggerRunId: true } } },
    });

  let existing = await find();
  if (!existing) return null;
  // the same id must mean the same message: anything else is a client bug, and quietly answering with the
  // earlier turn would hide it
  if (existing.content !== body.content) {
    throw new AppError("VALIDATION_FAILED", "clientMessageId: That id was already used for a different message.", {
      fields: { clientMessageId: ["Already used for a different message."] },
    });
  }

  // the original request may still be handing the run to Trigger.dev; give it a moment rather than fail a double-submit
  for (const deadline = Date.now() + replayWaitMs; !existing?.triggeredRuns[0]?.triggerRunId && Date.now() < deadline; ) {
    await sleep(50);
    existing = await find();
  }
  if (!existing) return null; // the original turn was undone while we waited: start over
  const run = existing.triggeredRuns[0];
  if (!run?.triggerRunId) throw new AppError("RUN_ACTIVE", "That message is still being sent. Try again in a moment.");
  return { replayed: true, message: serializeMessage(existing, run.id), runId: run.id, triggerRunId: run.triggerRunId };
}

/**
 * Everything a send needs, written together or not at all: the message, the placeholder for the reply, the run (whose
 * unique index allows one active run per chat) and the credit hold. A refused hold rolls all of it back.
 */
function createTurn(userId: string, chatId: string, body: SendMessageBody, traceId: string) {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const replyAt = new Date(now.getTime() + 1); // strictly after the question, so history always reads question then answer
    const userMessage = await tx.message.create({
      data: { chatId, userId, role: "USER", status: "COMPLETED", content: body.content, clientMessageId: body.clientMessageId ?? null, createdAt: now },
    });
    const assistantMessage = await tx.message.create({
      data: { chatId, userId, role: "ASSISTANT", status: "STREAMING", contentBlocks: [], createdAt: replyAt },
    });
    const run = await tx.agentRun.create({
      data: { chatId, userId, triggerMessageId: userMessage.id, assistantMessageId: assistantMessage.id, traceId },
    });
    await hold(tx, { userId, amount: env.CREDIT_ADMISSION_HOLD, reason: "agent turn admission hold", idempotencyKey: holdKey(run.id), agentRunId: run.id });

    // a chat still called "New chat" takes its name from its first message, so the sidebar is never a column of "New chat"
    const provisional = titleFrom(body.content, PROVISIONAL_TITLE_MAX);
    const named = provisional ? (await tx.chat.updateMany({ where: { id: chatId, title: DEFAULT_CHAT_TITLE }, data: { title: provisional } })).count === 1 : false;
    await tx.chat.update({ where: { id: chatId }, data: { lastMessageAt: replyAt } });
    return { userMessage, assistantMessage, run, replyAt, provisionalTitle: named ? provisional : null, newQuestion: true };
  });
}

type Created = Awaited<ReturnType<typeof createTurn>>;

/** The agent could not be started, so the send did not happen: remove it, return the credits, put the chat back. */
async function undoTurn({ userMessage, assistantMessage, run, replyAt, provisionalTitle, newQuestion }: Created, previousLastMessageAt: Date): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const ended = await finalizeRun(run.id, { status: "FAILED", errorCode: "DISPATCH_FAILED" }, tx); // releases the hold
      if (!ended) return; // the agent did start after all; leave the turn alone
      // a retry asked an existing question again: only its new reply goes, never the question
      const created = newQuestion ? [userMessage.id, assistantMessage.id] : [assistantMessage.id];
      await tx.message.deleteMany({ where: { id: { in: created } } }); // cascades to the run
      if (provisionalTitle) await tx.chat.updateMany({ where: { id: userMessage.chatId, title: provisionalTitle }, data: { title: DEFAULT_CHAT_TITLE } });
      await tx.chat.updateMany({ where: { id: userMessage.chatId, lastMessageAt: replyAt }, data: { lastMessageAt: previousLastMessageAt } });
    });
  } catch (err) {
    // the stale-run cleanup will end the orphaned run and give the credits back
    logger.error({ err, runId: run.id }, "could not undo a turn whose dispatch failed");
  }
}

async function saveTriggerRunId(runId: string, triggerRunId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await prisma.agentRun.updateMany({ where: { id: runId, triggerRunId: null }, data: { triggerRunId } });
      return;
    } catch (err) {
      // the agent is already running, so this must never fail the send; the task records its own id when it starts
      if (attempt === 2) logger.error({ err, runId, triggerRunId }, "could not save the Trigger.dev run id");
      else await sleep(50 * 2 ** attempt);
    }
  }
}

async function dispatch(created: Created, userId: string, chatId: string, traceId: string, timeoutMs: number): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`dispatch timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const payload = { agentRunId: created.run.id, chatId, userId, assistantMessageId: created.assistantMessage.id, traceId };
    return await Promise.race([dispatchAgentTurn(payload, dispatchKey(created.run.id)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function sendMessage(
  { userId, chatId, body: received, traceId }: { userId: string; chatId: string; body: SendMessageBody; traceId: string },
  { dispatchTimeoutMs = DISPATCH_TIMEOUT_MS, replayWaitMs = REPLAY_WAIT_MS }: SendOptions = {},
): Promise<SentTurn> {
  const body = { ...received, content: wellFormed(received.content) }; // exactly what will be stored, so replays compare equal
  if (body.attachments.length > 0) {
    throw new AppError("VALIDATION_FAILED", "attachments: Attachments aren't supported yet.", { fields: { attachments: ["Not supported yet."] } });
  }
  const chat = await requireChat(userId, chatId);

  for (let attempt = 0; attempt < 3; attempt++) {
    const earlier = await replay(chatId, body, replayWaitMs);
    if (earlier) return earlier;

    let created: Created;
    try {
      created = await createTurn(userId, chatId, body, traceId);
    } catch (error) {
      if (violates(error, "Message_chatId_clientMessageId_key")) continue; // a twin of this request won the race: replay it
      if (error instanceof AppError && error.code === "INSUFFICIENT_CREDITS" && (await reconcileUserRuns(userId, { force: true }))) {
        continue; // credits held by this user's dead runs (a lost worker) must not make this send look unaffordable
      }
      if (violates(error, "AgentRun_one_active_per_chat")) {
        // a run that is really dead (a lost worker) must not lock the chat: clean it up once, then try again
        if (attempt === 0 && (await reconcileChat(chatId, { force: true }))) continue;
        throw runActive();
      }
      throw error;
    }

    let triggerRunId: string;
    try {
      triggerRunId = await dispatch(created, userId, chatId, traceId, dispatchTimeoutMs);
    } catch (err) {
      logger.error({ err, runId: created.run.id, chatId }, "could not start the agent run");
      await undoTurn(created, chat.lastMessageAt);
      throw new AppError("SERVICE_UNAVAILABLE", "We couldn't start the agent. Please try again.");
    }
    await saveTriggerRunId(created.run.id, triggerRunId);
    return { replayed: false, message: serializeMessage(created.userMessage, created.run.id), runId: created.run.id, triggerRunId };
  }
  throw runActive();
}

const notRetryable = (message: string) => new AppError("RUN_NOT_RETRYABLE", message);
const replyGone = () => new AppError("NOT_FOUND", "That reply isn't there any more.");

/** A retry of this run that was already started (a double click, a repeated request): the same turn, never a second. */
async function existingRetry(runId: string, replayWaitMs: number): Promise<SentTurn | null> {
  const find = () =>
    prisma.agentRun.findUnique({ where: { retryOfRunId: runId }, select: { id: true, triggerRunId: true, triggerMessage: true } });
  let retry = await find();
  if (!retry) return null;
  // the first request may still be handing it to Trigger.dev; give it a moment rather than fail a double click
  for (const deadline = Date.now() + replayWaitMs; !retry?.triggerRunId && Date.now() < deadline; ) {
    await sleep(50);
    retry = await find();
  }
  if (!retry) return null; // that retry was undone while we waited: start over
  if (!retry.triggerRunId) throw new AppError("RUN_ACTIVE", "That retry is still starting. Try again in a moment.");
  return { replayed: true, message: serializeMessage(retry.triggerMessage, retry.id), runId: retry.id, triggerRunId: retry.triggerRunId };
}

/** Another request retried this run between our lookup and our write: answer with that retry instead. */
class RetryAlreadyStarted extends Error {}

/**
 * The new turn for a retry, written together or not at all. The chat row is locked first, so "is this still the chat's
 * latest turn?" cannot change underneath us: a send and a retry, or two retries, take turns instead of racing.
 */
function createRetryTurn(userId: string, original: { id: string; chatId: string; triggerMessageId: string }, traceId: string) {
  const { chatId } = original;
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Chat" WHERE id = ${chatId} FOR UPDATE`;
    if (locked.length === 0) throw replyGone(); // the chat was deleted a moment ago
    const latest = await tx.agentRun.findFirst({
      where: { chatId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, status: true, retryOfRunId: true },
    });
    if (latest && latest.id !== original.id) {
      if (latest.retryOfRunId === original.id) throw new RetryAlreadyStarted();
      throw notRetryable("Only the latest message can be retried.");
    }
    const status = latest?.status;
    if (status && (ACTIVE_STATUSES as readonly string[]).includes(status)) throw new AppError("RUN_ACTIVE", "This reply is still being written.");
    if (!status || !RETRYABLE_STATUSES.includes(status)) throw notRetryable("Only a failed or stopped reply can be retried.");

    const replyAt = new Date(); // after the failed reply, so the new answer reads below it
    const userMessage = await tx.message.findUniqueOrThrow({ where: { id: original.triggerMessageId } });
    const assistantMessage = await tx.message.create({
      data: { chatId, userId, role: "ASSISTANT", status: "STREAMING", contentBlocks: [], createdAt: replyAt },
    });
    const run = await tx.agentRun.create({
      data: { chatId, userId, triggerMessageId: userMessage.id, assistantMessageId: assistantMessage.id, traceId, retryOfRunId: original.id },
    });
    await hold(tx, { userId, amount: env.CREDIT_ADMISSION_HOLD, reason: "agent turn admission hold (retry)", idempotencyKey: holdKey(run.id), agentRunId: run.id });
    await tx.chat.update({ where: { id: chatId }, data: { lastMessageAt: replyAt } });
    return { userMessage, assistantMessage, run, replyAt, provisionalTitle: null, newQuestion: false };
  });
}

/**
 * Tries a failed or stopped turn again: the same question, a new reply, under the same rules as a send (one run per
 * chat, the credit hold, undone if the agent can't be started). Only the chat's latest turn can be retried, so the
 * conversation always reads in order; the failed reply stays visible above the new one. Retrying the same run twice
 * gives back the same retry.
 */
export async function retryRun(
  { userId, runId, traceId }: { userId: string; runId: string; traceId: string },
  { dispatchTimeoutMs = DISPATCH_TIMEOUT_MS, replayWaitMs = REPLAY_WAIT_MS }: SendOptions = {},
): Promise<SentTurn> {
  const original = await prisma.agentRun.findFirst({ where: { id: runId, userId }, select: { id: true, chatId: true, triggerMessageId: true } });
  if (!original) throw replyGone(); // another user's run is "not found" too, so nothing leaks
  const chat = await requireChat(userId, original.chatId);

  for (let attempt = 0; attempt < 3; attempt++) {
    const earlier = await existingRetry(runId, replayWaitMs);
    if (earlier) return earlier;

    let created: Created;
    try {
      created = await createRetryTurn(userId, original, traceId);
    } catch (error) {
      if (error instanceof RetryAlreadyStarted || violates(error, "AgentRun_retryOfRunId_key")) continue; // answer with that one
      if (error instanceof AppError && error.code === "INSUFFICIENT_CREDITS" && (await reconcileUserRuns(userId, { force: true }))) continue;
      if (violates(error, "AgentRun_one_active_per_chat")) {
        // a twin of this retry won (it may still be starting): the next pass waits for it and answers with it
        if (await prisma.agentRun.findUnique({ where: { retryOfRunId: runId }, select: { id: true } })) continue;
        if (attempt === 0 && (await reconcileChat(original.chatId, { force: true }))) continue;
        throw runActive();
      }
      throw error;
    }

    let triggerRunId: string;
    try {
      triggerRunId = await dispatch(created, userId, original.chatId, traceId, dispatchTimeoutMs);
    } catch (err) {
      logger.error({ err, runId: created.run.id, chatId: original.chatId, retryOf: runId }, "could not start the retry");
      await undoTurn(created, chat.lastMessageAt);
      throw new AppError("SERVICE_UNAVAILABLE", "We couldn't start the agent. Please try again.");
    }
    await saveTriggerRunId(created.run.id, triggerRunId);
    return { replayed: false, message: serializeMessage(created.userMessage, created.run.id), runId: created.run.id, triggerRunId };
  }
  throw runActive();
}

/** A token for following a run live. If one cannot be made the run still works: the client falls back to polling. */
export async function realtimeAccess(triggerRunId: string): Promise<{ token: string; expiresAt: Date }> {
  try {
    return await createRealtimeToken(triggerRunId);
  } catch (err) {
    logger.error({ err, triggerRunId }, "could not create a realtime token");
    return { token: "", expiresAt: new Date(0) }; // already expired, so the client asks for a fresh one straight away
  }
}
