import { prisma, type Prisma } from "#src/db/client.js";
import { AppError } from "#src/lib/errors.js";
import type { LedgerType } from "#src/generated/prisma/client.js";

type Tx = Prisma.TransactionClient;

export interface LedgerEntry {
  userId: string;
  amount: number; // always positive; the ledger stores the sign
  reason: string;
  /** The same key is applied at most once, however often the call is repeated. */
  idempotencyKey: string;
  agentRunId?: string;
}

// Ledger rows and the User counters change together, so every primitive must run inside the caller's transaction.
// Each returns false when the idempotency key was already used (a replay), and changes nothing in that case.

async function record(tx: Tx, type: LedgerType, signedAmount: number, e: LedgerEntry): Promise<boolean> {
  if (!Number.isSafeInteger(e.amount) || e.amount <= 0 || e.amount > 2_147_483_647) {
    throw new Error(`Credit amount must be a positive 32-bit integer, got ${e.amount}`);
  }
  // ON CONFLICT DO NOTHING: a duplicate key must not abort the surrounding transaction
  const { count } = await tx.creditLedger.createMany({
    data: [{ userId: e.userId, agentRunId: e.agentRunId ?? null, type, amount: signedAmount, reason: e.reason, idempotencyKey: e.idempotencyKey }],
    skipDuplicates: true,
  });
  return count === 1;
}

export async function grant(tx: Tx, e: LedgerEntry): Promise<boolean> {
  if (!(await record(tx, "GRANT", e.amount, e))) return false;
  await tx.$executeRaw`UPDATE "User" SET "balance" = "balance" + ${e.amount}, "updatedAt" = now() WHERE "id" = ${e.userId}`;
  return true;
}

/** Reserves credits. One conditional UPDATE, so concurrent holds can never spend more than is available. */
export async function hold(tx: Tx, e: LedgerEntry): Promise<boolean> {
  if (!(await record(tx, "HOLD", e.amount, e))) return false;
  const updated = await tx.$executeRaw`
    UPDATE "User" SET "held" = "held" + ${e.amount}, "updatedAt" = now()
    WHERE "id" = ${e.userId} AND "balance" - "held" >= ${e.amount}`;
  // throwing rolls back the ledger row written above
  if (updated === 0) throw new AppError("INSUFFICIENT_CREDITS", "You don't have enough credits for that.");
  return true;
}

export async function release(tx: Tx, e: LedgerEntry): Promise<boolean> {
  if (!(await record(tx, "RELEASE", -e.amount, e))) return false;
  const updated = await tx.$executeRaw`
    UPDATE "User" SET "held" = "held" - ${e.amount}, "updatedAt" = now()
    WHERE "id" = ${e.userId} AND "held" >= ${e.amount}`;
  if (updated === 0) throw new Error(`Releasing ${e.amount} credits for ${e.userId} but fewer are held`); // a bug, not a user error
  return true;
}

/**
 * Spends credits for good. Used to settle a hold: release it first (held goes down), then charge (balance goes down),
 * so `held <= balance` holds at every step. One conditional UPDATE, so a balance can never go below what is still held.
 */
export async function charge(tx: Tx, e: LedgerEntry): Promise<boolean> {
  if (!(await record(tx, "CHARGE", -e.amount, e))) return false;
  const updated = await tx.$executeRaw`
    UPDATE "User" SET "balance" = "balance" - ${e.amount}, "updatedAt" = now()
    WHERE "id" = ${e.userId} AND "balance" - "held" >= ${e.amount}`;
  if (updated === 0) throw new Error(`Charging ${e.amount} credits for ${e.userId} but fewer are available`); // a bug: it was held first
  return true;
}

export const getCredits = (userId: string) =>
  prisma.user.findUnique({ where: { id: userId }, select: { balance: true, held: true } });
