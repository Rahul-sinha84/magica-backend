import { z } from "zod";
import { blocksToText, ContentBlockSchema, ContentBlocksSchema, type ContentBlock } from "#src/contracts/index.js";
import { prisma, type Prisma } from "#src/db/client.js";
import { holdKey, releaseKey } from "#src/lib/idempotency.js";
import { logger } from "#src/lib/logger.js";
import { release } from "#src/services/credits.js";
import { endActiveInvocations } from "#src/services/toolInvocations.js";
import { dispatchWebhookDeliveries } from "#src/webhooks/dispatch.js";
import { recordRunEvent } from "#src/webhooks/events.js";

// Shared by the API and the Trigger.dev worker, so it must not import anything that only the server configures.

type Tx = Prisma.TransactionClient;

export const ACTIVE_STATUSES = ["PENDING", "RUNNING"] as const;
/** The turn failed because nobody answered its waitpoint in time (see src/waitpoints/wait.ts). It can be retried. */
export const WAITPOINT_EXPIRED = { code: "WAITPOINT_EXPIRED", message: "This approval expired. Send a new message to continue." } as const;
/** A run that ended without an answer, which the user may try again (only the chat's latest turn; see retryRun). */
export const RETRYABLE_STATUSES: readonly string[] = ["FAILED", "CANCELLED"];

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

const RUN_EVENT = { COMPLETED: "agent.completed", FAILED: "agent.failed", CANCELLED: "agent.canceled" } as const;

/** Ends the run; `deliveries` collects the webhook deliveries it records, to be sent once the transaction commits. */
async function apply(tx: Tx, runId: string, outcome: RunOutcome, deliveries: string[] = []): Promise<boolean> {
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

  // a run never ends with credits still reserved for its tools: any tool call still in progress is ended here, together
  await endActiveInvocations(tx, runId, outcome.status === "CANCELLED" ? "Stopped." : "Stopped because the turn ended.");
  // nor with a question still open: an unanswered waitpoint closes with it (expired if that is why the run ended)
  const waitpointEnd = outcome.errorCode === WAITPOINT_EXPIRED.code ? "EXPIRED" : "CANCELLED";
  await tx.waitpoint.updateMany({ where: { agentRunId: runId, status: "PENDING" }, data: { status: waitpointEnd, resolvedAt: new Date() } });

  const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { assistantMessageId: true, userId: true, chatId: true } });

  let blocks = outcome.blocks && z.array(ContentBlockSchema).parse(outcome.blocks); // the server only ever stores valid blocks
  if (outcome.status !== "COMPLETED") {
    // a tool can't still be running in a reply that has ended: close any open tool card, so none spins forever
    const current = blocks ?? ContentBlocksSchema.parse((await tx.message.findUnique({ where: { id: run.assistantMessageId }, select: { contentBlocks: true } }))?.contentBlocks ?? []);
    const closed = closeOpenWaitpoints(closeOpenTools(current, outcome.status === "CANCELLED" ? "Stopped." : "Stopped because the turn ended."), waitpointEnd === "EXPIRED" ? "expired" : "cancelled");
    if (closed !== current) blocks = closed;
  }
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
  deliveries.push(...(await recordRunEvent(tx, runId, RUN_EVENT[outcome.status])));
  return true;
}

/**
 * Marks every tool call still shown as running (or pending) as failed, with a result saying why, placed right after
 * it. Returns the same array when nothing was open.
 */
export function closeOpenTools(blocks: ContentBlock[], reason: string): ContentBlock[] {
  const open = blocks.filter((b) => b.type === "tool_call" && (b.status === "running" || b.status === "pending") && !blocks.some((r) => r.type === "tool_result" && r.toolCallId === b.toolCallId));
  if (open.length === 0) return blocks;
  return blocks.flatMap((block) => {
    if (block.type !== "tool_call" || !open.includes(block)) return [block];
    return [{ ...block, status: "failed" as const }, { type: "tool_result" as const, toolCallId: block.toolCallId, toolName: block.toolName, isError: true, errorMessage: reason }];
  });
}

/** Marks every waitpoint card still waiting for an answer as `status`. Returns the same array when none was waiting. */
export function closeOpenWaitpoints(blocks: ContentBlock[], status: "expired" | "cancelled"): ContentBlock[] {
  if (!blocks.some((b) => b.type === "waitpoint" && b.status === "pending")) return blocks;
  return blocks.map((block) => (block.type === "waitpoint" && block.status === "pending" ? { ...block, status } : block));
}

/**
 * The single way a run ends: the task finishing, failing or being cancelled, the stale-run cleanup, a chat being
 * deleted, a dispatch that never happened. In one transaction it moves the run to its final state, finalises the reply
 * message, and releases the credit hold. Returns false (and changes nothing) if the run had already ended.
 */
export async function finalizeRun(runId: string, outcome: RunOutcome, tx?: Tx): Promise<boolean> {
  // the caller's transaction decides whether this sticks, so it logs (its webhooks are sent by the outbox sweeper)
  if (tx) return apply(tx, runId, outcome);
  const deliveries: string[] = [];
  const ended = await prisma.$transaction((t) => apply(t, runId, outcome, deliveries));
  if (ended) logger.info({ runId, status: outcome.status, errorCode: outcome.errorCode }, "run ended");
  if (deliveries.length > 0) await dispatchWebhookDeliveries(deliveries);
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
