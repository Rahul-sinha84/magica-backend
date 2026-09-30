import { beforeEach, describe, expect, it } from "vitest";
import { prisma, type Prisma } from "#src/db/client.js";
import { AppError } from "#src/lib/errors.js";
import { getCredits, grant, hold, release, type LedgerEntry } from "#src/services/credits.js";
import { fixtures, resetDb } from "../helpers/db.js";

beforeEach(resetDb);

const entry = (userId: string, amount: number, idempotencyKey: string, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  userId,
  amount,
  reason: "test",
  idempotencyKey,
  ...extra,
});

const tx = <T>(fn: (t: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(fn);
const balanceOf = (id: string) => prisma.user.findUniqueOrThrow({ where: { id }, select: { balance: true, held: true } });
const ledgerOf = (userId: string) => prisma.creditLedger.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
const failure = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

describe("grant", () => {
  it("adds to the balance and writes one positive ledger row", async () => {
    const user = await fixtures.user({ balance: 100 });
    expect(await tx((t) => grant(t, entry(user.id, 50, "g1")))).toBe(true);
    expect(await balanceOf(user.id)).toEqual({ balance: 150, held: 0 });
    expect(await ledgerOf(user.id)).toMatchObject([{ type: "GRANT", amount: 50, idempotencyKey: "g1" }]);
  });

  it("applies a repeated idempotency key only once", async () => {
    const user = await fixtures.user({ balance: 100 });
    expect(await tx((t) => grant(t, entry(user.id, 50, "g1")))).toBe(true);
    expect(await tx((t) => grant(t, entry(user.id, 50, "g1")))).toBe(false);
    expect(await balanceOf(user.id)).toEqual({ balance: 150, held: 0 });
    expect(await ledgerOf(user.id)).toHaveLength(1);
  });

  it("changes nothing for a user that does not exist", async () => {
    expect(await failure(tx((t) => grant(t, entry("ghost", 50, "g1"))))).toBeDefined();
    expect(await prisma.creditLedger.count()).toBe(0);
  });

  it("rolls back when it would overflow the 32-bit balance", async () => {
    const user = await fixtures.user({ balance: 2_147_483_000 });
    expect(await failure(tx((t) => grant(t, entry(user.id, 1_000, "big"))))).toBeDefined();
    expect(await balanceOf(user.id)).toEqual({ balance: 2_147_483_000, held: 0 });
    expect(await prisma.creditLedger.count()).toBe(0);
  });
});

describe("hold", () => {
  it("reserves credits without changing the balance", async () => {
    const user = await fixtures.user({ balance: 1_000 });
    expect(await tx((t) => hold(t, entry(user.id, 400, "h1")))).toBe(true);
    expect(await balanceOf(user.id)).toEqual({ balance: 1_000, held: 400 });
    expect(await ledgerOf(user.id)).toMatchObject([{ type: "HOLD", amount: 400 }]);
  });

  it("allows holding exactly everything that is available, and not one credit more", async () => {
    const user = await fixtures.user({ balance: 1_000, held: 250 });
    expect(await tx((t) => hold(t, entry(user.id, 750, "all")))).toBe(true);
    const error = await failure(tx((t) => hold(t, entry(user.id, 1, "one-more"))));
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("INSUFFICIENT_CREDITS");
    expect(await balanceOf(user.id)).toEqual({ balance: 1_000, held: 1_000 });
  });

  it("leaves no ledger row behind when it is refused (the whole transaction rolls back)", async () => {
    const user = await fixtures.user({ balance: 100 });
    expect(await failure(tx((t) => hold(t, entry(user.id, 101, "too-much"))))).toBeInstanceOf(AppError);
    expect(await prisma.creditLedger.count()).toBe(0);
    expect(await balanceOf(user.id)).toEqual({ balance: 100, held: 0 });
  });

  it("treats a replay as already done, even if the credits would no longer be available", async () => {
    const user = await fixtures.user({ balance: 100 });
    await tx((t) => hold(t, entry(user.id, 100, "h1")));
    expect(await tx((t) => hold(t, entry(user.id, 100, "h1")))).toBe(false);
    expect(await balanceOf(user.id)).toEqual({ balance: 100, held: 100 });
  });

  it("never lets concurrent holds spend more than is available", async () => {
    const user = await fixtures.user({ balance: 500_000 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => tx((t) => hold(t, entry(user.id, 100_000, `h${i}`)))));
    const refused = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(refused).toHaveLength(5);
    for (const r of refused) expect(r.reason).toBeInstanceOf(AppError);
    expect(await balanceOf(user.id)).toEqual({ balance: 500_000, held: 500_000 });
    expect(await prisma.creditLedger.count({ where: { type: "HOLD" } })).toBe(5);
  });

  it("applies one key exactly once when the same hold arrives concurrently", async () => {
    const user = await fixtures.user({ balance: 1_000 });
    const results = await Promise.all(Array.from({ length: 6 }, () => tx((t) => hold(t, entry(user.id, 100, "same")))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await balanceOf(user.id)).toEqual({ balance: 1_000, held: 100 });
  });

  it("links the ledger row to the run", async () => {
    const user = await fixtures.user();
    const run = await fixtures.run((await fixtures.chat(user.id)).id, user.id);
    await tx((t) => hold(t, entry(user.id, 10, "h1", { agentRunId: run.id })));
    expect(await ledgerOf(user.id)).toMatchObject([{ agentRunId: run.id }]);
  });
});

describe("release", () => {
  it("returns held credits and writes a negative ledger row", async () => {
    const user = await fixtures.user({ balance: 1_000 });
    await tx((t) => hold(t, entry(user.id, 400, "h1")));
    expect(await tx((t) => release(t, entry(user.id, 400, "r1")))).toBe(true);
    expect(await balanceOf(user.id)).toEqual({ balance: 1_000, held: 0 });
    expect((await ledgerOf(user.id)).map((l) => [l.type, l.amount])).toEqual([["HOLD", 400], ["RELEASE", -400]]);
  });

  it("releases once however many times it is repeated (completion, hooks and cancel can all race)", async () => {
    const user = await fixtures.user({ balance: 1_000 });
    await tx((t) => hold(t, entry(user.id, 400, "h1")));
    const results = await Promise.all(Array.from({ length: 6 }, () => tx((t) => release(t, entry(user.id, 400, "r1")))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await balanceOf(user.id)).toEqual({ balance: 1_000, held: 0 });
  });

  it("refuses to release more than is held, and changes nothing", async () => {
    const user = await fixtures.user({ balance: 1_000 });
    await tx((t) => hold(t, entry(user.id, 100, "h1")));
    const error = await failure(tx((t) => release(t, entry(user.id, 101, "r1"))));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AppError); // a bug in our bookkeeping, not something the user did
    expect(await balanceOf(user.id)).toEqual({ balance: 1_000, held: 100 });
    expect(await prisma.creditLedger.count({ where: { type: "RELEASE" } })).toBe(0);
  });
});

describe("transactions and validation", () => {
  it("commits or rolls back grants and holds together", async () => {
    const user = await fixtures.user({ balance: 100 });
    const error = await failure(
      tx(async (t) => {
        await grant(t, entry(user.id, 50, "g1"));
        await hold(t, entry(user.id, 120, "h1"));
        throw new Error("something else failed afterwards");
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(await balanceOf(user.id)).toEqual({ balance: 100, held: 0 });
    expect(await prisma.creditLedger.count()).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])("rejects the amount %s before touching anything", async (amount) => {
    const user = await fixtures.user({ balance: 100 });
    for (const op of [grant, hold, release]) {
      expect(await failure(tx((t) => op(t, entry(user.id, amount, `k-${String(amount)}`))))).toBeInstanceOf(Error);
    }
    expect(await prisma.creditLedger.count()).toBe(0);
    expect(await balanceOf(user.id)).toEqual({ balance: 100, held: 0 });
  });

  it("updates the user's updatedAt", async () => {
    const user = await fixtures.user({ balance: 100 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await tx((t) => grant(t, entry(user.id, 1, "g1")));
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime());
  });
});

describe("getCredits", () => {
  it("reads the balance and what is held, or null for an unknown user", async () => {
    const user = await fixtures.user({ balance: 900, held: 100 });
    expect(await getCredits(user.id)).toEqual({ balance: 900, held: 100 });
    expect(await getCredits("ghost")).toBeNull();
  });
});
