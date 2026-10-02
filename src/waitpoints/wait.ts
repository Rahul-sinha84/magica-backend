import type { Logger } from "pino";
import { TurnError } from "#src/agent/turnError.js";
import { AgentStreamChunkSchema, WAITPOINT_LIFETIME_MS, type AgentStreamChunk, type AgentStreamMetadata, type CreditPayload, type PlanPayload, type WaitpointType } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import type { Waitpoint as WaitpointRow } from "#src/generated/prisma/client.js";
import { toJson, WAITPOINT_EXPIRED } from "#src/services/runs.js";
import type { WaitAnswer, WaitFor } from "#src/tools/registry.js";
import { readAnswer, STATUS_FOR_ACTION, statusOf, WAITPOINT_KINDS } from "#src/waitpoints/types.js";

// How a turn pauses for the user. The run waits on a Trigger.dev waitpoint token, so it holds no worker (and no
// concurrency slot) while it waits, and the wait doesn't count against its time limit. The Waitpoint row is the durable
// record: whatever wakes the run (the answer, the token's timeout, a stop), the row says what happened.

/** Trigger.dev's waitpoint tokens, as the turn uses them (replaced in tests). */
export interface WaitTokens {
  /** Creates the token the run will wait on; the same key gives back the same token. */
  create(options: { idempotencyKey: string; timeout: Date; tags: string[] }): Promise<{ id: string }>;
  /** Waits until the token is completed (`ok`, with what it was completed with) or times out. */
  wait(tokenId: string): Promise<{ ok: true; output: unknown } | { ok: false }>;
}

export interface WaitContext {
  runId: string;
  tokens: WaitTokens;
  /** Adds a chunk to the reply (and the live stream). */
  emit: (chunk: AgentStreamChunk) => void;
  /** Saves the reply so far; false once it is no longer the turn's to write (the run ended). */
  checkpoint: () => Promise<boolean>;
  setStatus: (status: AgentStreamMetadata) => void;
  now: () => number;
  log: Logger;
  /** Aborted when the run is stopped. */
  signal: AbortSignal;
}

// the run was stopped or ended while it waited: nothing to report (whatever ended it already did)
const RUN_ENDED = { code: "RUN_ENDED", message: "The run was stopped." } as const;
const ended = () => new TurnError(RUN_ENDED.code, RUN_ENDED.message);

/** Trigger.dev's idempotency key for a waitpoint's token: one token per run, kind and asking (`key`). */
export const waitpointTokenKey = (runId: string, type: WaitpointType, key: string) => `waitpoint:${runId}:${type}:${key}`;

/**
 * Pauses the turn until the user answers: writes the waitpoint, shows the card, waits, and reports the answer. An
 * expired waitpoint ends the turn (WAITPOINT_EXPIRED, which can be retried); so does a stop. `key` names this asking
 * within the run (for example the step and tool call), so asking again for the same thing gives the same waitpoint.
 */
export async function waitFor(ctx: WaitContext, type: WaitpointType, payload: PlanPayload | CreditPayload, key: string): Promise<WaitAnswer> {
  const kind = WAITPOINT_KINDS[type];
  const parsed: unknown = kind.payload.parse(payload);
  const expiresAt = new Date(ctx.now() + WAITPOINT_LIFETIME_MS);
  // the token times out at the same moment the waitpoint expires
  const token = await ctx.tokens.create({ idempotencyKey: waitpointTokenKey(ctx.runId, type, key), timeout: expiresAt, tags: [`run_${ctx.runId}`] });

  const row = await prisma.$transaction(async (tx) => {
    // The run is locked while its waitpoint is written, so a stop at the same moment either comes first (nothing to
    // wait for) or after, and then finds the waitpoint and cancels it with the run.
    const { count } = await tx.agentRun.updateMany({ where: { id: ctx.runId, status: "RUNNING" }, data: { updatedAt: new Date(ctx.now()) } });
    if (count === 0) return null;
    const same = await tx.waitpoint.findUnique({ where: { triggerTokenId: token.id } });
    if (same) return same; // the same asking again: the same waitpoint, answered or not
    // one at a time: a waitpoint still pending here was left by an attempt that never finished
    await tx.waitpoint.updateMany({ where: { agentRunId: ctx.runId, status: "PENDING" }, data: { status: "CANCELLED", resolvedAt: new Date(ctx.now()) } });
    // dated by the same clock as its expiry and its answer, so the wait time adds up
    return tx.waitpoint.create({ data: { agentRunId: ctx.runId, type: kind.db, triggerTokenId: token.id, payload: toJson(parsed), expiresAt, createdAt: new Date(ctx.now()) } });
  });
  if (!row) throw ended();

  const log = ctx.log.child({ waitpointId: row.id });
  ctx.emit(AgentStreamChunkSchema.parse({ type: "waitpoint-start", waitpointId: row.id, waitpointType: type, payload: row.payload, expiresAt: row.expiresAt.toISOString() }));
  if (!(await ctx.checkpoint())) throw ended(); // a reload shows the card from here on
  ctx.setStatus({ status: "waiting", waitpointId: row.id });
  log.info({ type, expiresAt: row.expiresAt.toISOString() }, "waiting for the user's answer");

  const woken = row.status === "PENDING" ? await untilAnswered(ctx, token.id) : ({ ok: false } as const);
  const settled = await settle(row.id, type, woken, ctx.now, log);
  if (!settled) throw ended(); // the run is gone (its chat was deleted)

  const status = statusOf(settled.status);
  const answer = readAnswer(type, settled.response);
  const waitedMs = Math.max(0, (settled.resolvedAt ?? new Date(ctx.now())).getTime() - settled.createdAt.getTime());
  if (status === "pending") throw new Error("a settled waitpoint is never pending"); // settle() guarantees it
  ctx.emit({ type: "waitpoint-end", waitpointId: row.id, status, waitedMs, ...(answer?.feedback !== undefined && { feedback: answer.feedback }) });
  log.info({ status, waitedMs }, "waitpoint over");

  if (status === "expired") throw new TurnError(WAITPOINT_EXPIRED.code, WAITPOINT_EXPIRED.message);
  if (status === "cancelled") throw ended();
  if (!(await ctx.checkpoint())) throw ended();
  ctx.setStatus({ status: "working" });
  return { status, ...(answer?.feedback !== undefined && { feedback: answer.feedback }) };
}

/** The token's outcome, or the stop's reason if the run is stopped first. */
async function untilAnswered(ctx: WaitContext, tokenId: string): Promise<{ ok: true; output: unknown } | { ok: false }> {
  ctx.signal.throwIfAborted();
  let stop: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(ctx.signal.reason instanceof Error ? ctx.signal.reason : new DOMException("The run was stopped", "AbortError"));
    ctx.signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([ctx.tokens.wait(tokenId), stopped]);
  } finally {
    if (stop) ctx.signal.removeEventListener("abort", stop);
  }
}

/**
 * What became of the waitpoint, from its row: the answer, the expiry, or a cancel. A row still pending when the run
 * wakes is settled here: with the token's answer (it was answered, but saving the row didn't go through), or else as
 * expired. If something else settles it at the same moment, that wins. Null when the row is gone.
 */
async function settle(id: string, type: WaitpointType, woken: { ok: true; output: unknown } | { ok: false }, now: () => number, log: Logger): Promise<WaitpointRow | null> {
  const current = await prisma.waitpoint.findUnique({ where: { id } });
  if (!current || current.status !== "PENDING") return current;
  const answer = woken.ok ? readAnswer(type, woken.output) : null;
  if (woken.ok && !answer) log.warn("the waitpoint's token was completed without a valid answer; treating it as expired");
  const data = answer ? { status: STATUS_FOR_ACTION[answer.action], response: toJson(answer) } : { status: "EXPIRED" as const };
  await prisma.waitpoint.updateMany({ where: { id, status: "PENDING" }, data: { ...data, resolvedAt: new Date(now()) } });
  return prisma.waitpoint.findUnique({ where: { id } });
}

/** Whether the user has approved a plan in this run (plan mode: until then, tools that cost credits are refused). */
export async function planApproved(runId: string): Promise<boolean> {
  return (await prisma.waitpoint.count({ where: { agentRunId: runId, type: "PLAN", status: "APPROVED" } })) > 0;
}

/**
 * The turn's way to wait, one waitpoint at a time (tools in a step may run side by side, but the user answers one
 * question at a time). `key` names the asking: the same key gives the same waitpoint.
 */
export function createWaiter(ctx: WaitContext): (key: string) => WaitFor {
  let queue: Promise<unknown> = Promise.resolve();
  return (key) =>
    ((type: WaitpointType, payload: PlanPayload | CreditPayload) => {
      const turn = queue.then(() => waitFor(ctx, type, payload, key));
      queue = turn.catch(() => undefined);
      return turn;
    });
}
