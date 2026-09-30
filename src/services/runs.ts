import { z } from "zod";
import { blocksToText, ContentBlockSchema, type ContentBlock } from "#src/contracts/index.js";
import { prisma, type Prisma } from "#src/db/client.js";
import { holdKey, releaseKey } from "#src/lib/idempotency.js";
import { logger } from "#src/lib/logger.js";
import { release } from "#src/services/credits.js";

// Shared by the API and the Trigger.dev worker, so it must not import anything that only the server configures.

type Tx = Prisma.TransactionClient;

export const ACTIVE_STATUSES = ["PENDING", "RUNNING"] as const;

export interface RunOutcome {
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  errorCode?: string;
  /** Safe to show to the user. */
  errorMessage?: string;
  /** The final content. Left out, what was already saved while streaming (the partial reply) is kept as it is. */
  blocks?: ContentBlock[];
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

// What the JSONB column will hold: plain JSON, with `undefined` keys dropped exactly as the database would drop them.
export const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

async function apply(tx: Tx, runId: string, outcome: RunOutcome): Promise<boolean> {
  // The compare-and-set that makes every way of ending a run safe to race: only the first caller wins.
  const { count } = await tx.agentRun.updateMany({
    where: { id: runId, status: { in: [...ACTIVE_STATUSES] } },
    data: {
      status: outcome.status,
      completedAt: new Date(),
      errorCode: outcome.errorCode ?? null,
      errorMessage: outcome.errorMessage ?? null,
      ...(outcome.model !== undefined && { model: outcome.model }),
      ...(outcome.inputTokens !== undefined && { inputTokens: outcome.inputTokens }),
      ...(outcome.outputTokens !== undefined && { outputTokens: outcome.outputTokens }),
    },
  });
  if (count === 0) return false;

  const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { assistantMessageId: true, userId: true, chatId: true } });

  const blocks = outcome.blocks && z.array(ContentBlockSchema).parse(outcome.blocks); // the server only ever stores valid blocks
  await tx.message.update({
    where: { id: run.assistantMessageId },
    data: { status: outcome.status, ...(blocks && { contentBlocks: toJson(blocks), content: blocksToText(blocks) }) },
  });

  // give back exactly what was held at send time (read from the ledger, so a changed setting can't misstate it)
  const held = await tx.creditLedger.findUnique({ where: { idempotencyKey: holdKey(runId) }, select: { amount: true } });
  if (held) {
    await release(tx, {
      userId: run.userId,
      amount: held.amount,
      reason: `agent turn ${outcome.status.toLowerCase()}`,
      idempotencyKey: releaseKey(runId),
      agentRunId: runId,
    });
  }

  if (outcome.status === "COMPLETED") await tx.chat.update({ where: { id: run.chatId }, data: { lastMessageAt: new Date() } });
  return true;
}

/**
 * The single way a run ends: the task finishing, failing or being cancelled, the stale-run cleanup, a chat being
 * deleted, a dispatch that never happened. In one transaction it moves the run to its final state, finalises the reply
 * message, and releases the credit hold. Returns false (and changes nothing) if the run had already ended.
 */
export async function finalizeRun(runId: string, outcome: RunOutcome, tx?: Tx): Promise<boolean> {
  if (tx) return apply(tx, runId, outcome); // the caller's transaction decides whether this sticks, so it logs
  const ended = await prisma.$transaction((t) => apply(t, runId, outcome));
  if (ended) logger.info({ runId, status: outcome.status, errorCode: outcome.errorCode }, "run ended");
  return ended;
}

/** The chat's run in flight (at most one, by the database's partial unique index), with its saved partial reply. */
export const findActiveRun = (chatId: string, userId?: string) =>
  prisma.agentRun.findFirst({
    where: { chatId, status: { in: [...ACTIVE_STATUSES] }, ...(userId && { userId }) },
    orderBy: { createdAt: "desc" },
    include: { assistantMessage: { select: { updatedAt: true, contentBlocks: true } } },
  });

export type ActiveRun = NonNullable<Awaited<ReturnType<typeof findActiveRun>>>;
