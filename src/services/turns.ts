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
import { finalizeRun } from "#src/services/runs.js";
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
    return { userMessage, assistantMessage, run, replyAt, provisionalTitle: named ? provisional : null };
  });
}

type Created = Awaited<ReturnType<typeof createTurn>>;

/** The agent could not be started, so the send did not happen: remove it, return the credits, put the chat back. */
async function undoTurn({ userMessage, assistantMessage, run, replyAt, provisionalTitle }: Created, previousLastMessageAt: Date): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const ended = await finalizeRun(run.id, { status: "FAILED", errorCode: "DISPATCH_FAILED" }, tx); // releases the hold
      if (!ended) return; // the agent did start after all; leave the turn alone
      await tx.message.deleteMany({ where: { id: { in: [userMessage.id, assistantMessage.id] } } }); // cascades to the run
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

/** A token for following a run live. If one cannot be made the run still works: the client falls back to polling. */
export async function realtimeAccess(triggerRunId: string): Promise<{ token: string; expiresAt: Date }> {
  try {
    return await createRealtimeToken(triggerRunId);
  } catch (err) {
    logger.error({ err, triggerRunId }, "could not create a realtime token");
    return { token: "", expiresAt: new Date(0) }; // already expired, so the client asks for a fresh one straight away
  }
}
