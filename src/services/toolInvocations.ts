import type { AudioBlock, ImageBlock, VideoBlock } from "#src/contracts/index.js";
import { prisma, Prisma } from "#src/db/client.js";
import { AppError } from "#src/lib/errors.js";
import { toolChargeKey, toolHoldKey, toolReleaseKey } from "#src/lib/idempotency.js";
import { charge, hold, release } from "#src/services/credits.js";
import { addGeneratedMedia } from "#src/services/media.js";

type Tx = Prisma.TransactionClient;
// JSONB holds plain JSON (undefined keys dropped, as the database would drop them)
const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

// A tool call's lifecycle and its money, in one place. Every change is a compare-and-set on the invocation's status,
// in the same transaction as the ledger rows it causes, so a call is charged or released exactly once however often
// any step is repeated (a retried task, a duplicated hook, a cancel racing a completion).
//
//   PENDING ──(credits reserved)──> DISPATCHING (before the external call) ──> RUNNING (Magica run id saved)
//      └──────────────┴─────────────────────┴──> COMPLETED (charged) | FAILED / CANCELLED (released)

const ACTIVE = ["PENDING", "DISPATCHING", "RUNNING"] as const;

export class InsufficientCreditsForTool extends AppError {
  constructor() {
    super("INSUFFICIENT_CREDITS", "You don't have enough credits for this.");
  }
}

export interface NewInvocation {
  agentRunId: string;
  userId: string;
  toolCallId: string;
  toolName: string;
  /** the validated input (what the tool will run with) */
  input: unknown;
  /** credits reserved now and charged on success */
  creditCost: number;
}

/**
 * Records a tool call and reserves its credits, together. The same (run, tool call) gives back the same invocation,
 * so asking twice never reserves twice. Short of credits: nothing is written and InsufficientCreditsForTool is thrown.
 */
export async function createInvocation(call: NewInvocation, db: typeof prisma = prisma) {
  const existing = await db.toolInvocation.findUnique({ where: { agentRunId_toolCallId: { agentRunId: call.agentRunId, toolCallId: call.toolCallId } } });
  if (existing) return existing;
  try {
    return await db.$transaction(async (tx) => {
      const invocation = await tx.toolInvocation.create({
        data: { agentRunId: call.agentRunId, toolCallId: call.toolCallId, toolName: call.toolName, input: toJson(call.input), status: "PENDING" },
      });
      if (call.creditCost > 0) {
        try {
          await hold(tx, { userId: call.userId, amount: call.creditCost, reason: `tool ${call.toolName}`, idempotencyKey: toolHoldKey(invocation.id), agentRunId: call.agentRunId });
        } catch (error) {
          if (error instanceof AppError && error.code === "INSUFFICIENT_CREDITS") throw new InsufficientCreditsForTool();
          throw error;
        }
      }
      return invocation;
    });
  } catch (error) {
    // the same call recorded at the same moment by a twin request: answer with that one
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return db.toolInvocation.findUniqueOrThrow({ where: { agentRunId_toolCallId: { agentRunId: call.agentRunId, toolCallId: call.toolCallId } } });
    }
    throw error;
  }
}

/** The credits reserved for an invocation when it was recorded (null when it cost nothing). Each settlement of them is
 *  keyed by the invocation, so it applies once even if this is read again. */
async function heldFor(tx: Tx, invocationId: string): Promise<{ userId: string; amount: number; agentRunId: string | null } | null> {
  const held = await tx.creditLedger.findUnique({ where: { idempotencyKey: toolHoldKey(invocationId) }, select: { userId: true, amount: true, agentRunId: true } });
  return held && held.amount > 0 ? held : null;
}

/** PENDING -> DISPATCHING, just before the external call. False if it was no longer pending (another attempt took it). */
export async function markDispatching(invocationId: string, db: typeof prisma = prisma): Promise<boolean> {
  const { count } = await db.toolInvocation.updateMany({ where: { id: invocationId, status: "PENDING" }, data: { status: "DISPATCHING", dispatchedAt: new Date() } });
  return count === 1;
}

/** Saves Magica's run id the moment it is known (DISPATCHING -> RUNNING, or just the id if already RUNNING). */
export async function markRunning(invocationId: string, magicaRunId: string, db: typeof prisma = prisma): Promise<boolean> {
  const { count } = await db.toolInvocation.updateMany({
    where: { id: invocationId, status: { in: ["DISPATCHING", "RUNNING"] } },
    data: { status: "RUNNING", magicaRunId },
  });
  return count === 1;
}

export interface Completion {
  output: unknown;
  durationMs: number;
  providerCost?: number | null;
  /** what the call made; added to the user's media library in the same transaction */
  assets?: readonly (ImageBlock | VideoBlock | AudioBlock)[];
}

/**
 * Finishes a successful call and charges for it: release the reservation, then charge the same amount, in the same
 * transaction as the status change. False when the call had already ended (cancelled meanwhile): nothing is charged.
 */
export async function completeInvocation(invocationId: string, done: Completion, db: typeof prisma = prisma): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const reserved = await heldFor(tx, invocationId);
    const { count } = await tx.toolInvocation.updateMany({
      where: { id: invocationId, status: { in: ["DISPATCHING", "RUNNING"] } },
      data: {
        status: "COMPLETED",
        output: toJson(done.output),
        durationMs: Math.max(0, Math.round(done.durationMs)),
        providerCost: done.providerCost == null ? null : Math.max(0, Math.round(done.providerCost)),
        creditCost: reserved?.amount ?? 0,
        completedAt: new Date(),
        errorMessage: null,
      },
    });
    if (count === 0) return false;
    if (reserved) {
      const entry = { userId: reserved.userId, amount: reserved.amount, agentRunId: reserved.agentRunId ?? undefined };
      await release(tx, { ...entry, reason: "tool reservation settled", idempotencyKey: toolReleaseKey(invocationId) });
      await charge(tx, { ...entry, reason: "tool call", idempotencyKey: toolChargeKey(invocationId) });
    }
    if (done.assets?.length) await addGeneratedMedia(tx, invocationId, done.assets);
    return true;
  });
}

/**
 * Ends a call that did not succeed (FAILED) or was stopped (CANCELLED), and gives its reserved credits back. False when
 * it had already ended. `errorMessage` must be safe to show.
 */
export async function endInvocation(invocationId: string, status: "FAILED" | "CANCELLED", errorMessage: string | null, db: typeof prisma = prisma): Promise<boolean> {
  return db.$transaction((tx) => endInvocationIn(tx, invocationId, status, errorMessage));
}

/**
 * Ends every tool call of a run that is still in progress, releasing their credits. Called inside finalizeRun, so a
 * run never ends (finished, failed, stopped, cleaned up, or its chat deleted) while credits stay reserved for its tools;
 * a tool that finishes later finds its call already ended and charges nothing.
 */
export async function endActiveInvocations(tx: Tx, agentRunId: string, errorMessage: string): Promise<number> {
  const active = await tx.toolInvocation.findMany({ where: { agentRunId, status: { in: [...ACTIVE] } }, select: { id: true } });
  let ended = 0;
  for (const { id } of active) if (await endInvocationIn(tx, id, "CANCELLED", errorMessage)) ended++;
  return ended;
}

async function endInvocationIn(tx: Tx, invocationId: string, status: "FAILED" | "CANCELLED", errorMessage: string | null): Promise<boolean> {
  {
    const current = await tx.toolInvocation.findUnique({ where: { id: invocationId }, select: { dispatchedAt: true } });
    const { count } = await tx.toolInvocation.updateMany({
      where: { id: invocationId, status: { in: [...ACTIVE] } },
      data: {
        status,
        errorMessage,
        creditCost: 0,
        completedAt: new Date(),
        ...(current?.dispatchedAt && { durationMs: Math.max(0, Date.now() - current.dispatchedAt.getTime()) }),
      },
    });
    if (count === 0) return false;
    const reserved = await heldFor(tx, invocationId);
    if (reserved) {
      await release(tx, { userId: reserved.userId, amount: reserved.amount, agentRunId: reserved.agentRunId ?? undefined, reason: `tool call ${status.toLowerCase()}`, idempotencyKey: toolReleaseKey(invocationId) });
    }
    return true;
  }
}

/** The total app credits the run's tool calls were charged. */
export async function turnToolCost(agentRunId: string, db: typeof prisma = prisma): Promise<number> {
  const { _sum } = await db.toolInvocation.aggregate({ where: { agentRunId, status: "COMPLETED" }, _sum: { creditCost: true } });
  return _sum.creditCost ?? 0;
}
