import { beforeEach, describe, expect, it } from "vitest";
import { Prisma, prisma } from "#src/db/client.js";
import { fixtures, resetDb } from "../helpers/db.js";

beforeEach(resetDb);

/** Resolves to the Prisma error code (e.g. P2002) or the raw message when the error is not a known request error. */
async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof Prisma.PrismaClientKnownRequestError ? e.code : String(e);
  }
  return "no error";
}

/** Resolves to the full error message; CHECK violations surface as P2039 with the constraint name in the text. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "no error";
}

const ledger = (userId: string, overrides: Partial<Prisma.CreditLedgerUncheckedCreateInput> = {}) =>
  prisma.creditLedger.create({
    data: { userId, type: "GRANT", amount: 100, reason: "test", idempotencyKey: crypto.randomUUID(), ...overrides },
  });

describe("one active run per chat (partial unique index)", () => {
  it.each([
    ["PENDING", "PENDING"],
    ["PENDING", "RUNNING"],
    ["RUNNING", "RUNNING"],
  ] as const)("rejects a %s run when a %s run exists", async (first, second) => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    await fixtures.run(chat.id, user.id, first);
    expect(await failure(fixtures.run(chat.id, user.id, second))).toBe("P2002");
  });

  it("allows any number of finished runs in one chat", async () => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    for (const status of ["COMPLETED", "FAILED", "CANCELLED", "COMPLETED"] as const) {
      await fixtures.run(chat.id, user.id, status);
    }
    expect(await prisma.agentRun.count({ where: { chatId: chat.id } })).toBe(4);
  });

  it("allows a new active run after the previous one finished", async () => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    await fixtures.run(chat.id, user.id, "COMPLETED");
    await expect(fixtures.run(chat.id, user.id, "PENDING")).resolves.toBeDefined();
  });

  it("frees the slot when an active run transitions to a terminal status", async () => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    const run = await fixtures.run(chat.id, user.id, "RUNNING");
    expect(await failure(fixtures.run(chat.id, user.id, "PENDING"))).toBe("P2002");

    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "COMPLETED" } });
    await expect(fixtures.run(chat.id, user.id, "PENDING")).resolves.toBeDefined();
  });

  it("does not let a finished run be re-activated while another is active", async () => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    const finished = await fixtures.run(chat.id, user.id, "FAILED");
    await fixtures.run(chat.id, user.id, "RUNNING");
    expect(await failure(prisma.agentRun.update({ where: { id: finished.id }, data: { status: "RUNNING" } }))).toBe("P2002");
  });

  it("allows one active run in each of several chats", async () => {
    const user = await fixtures.user();
    const [a, b] = [await fixtures.chat(user.id), await fixtures.chat(user.id)];
    await fixtures.run(a.id, user.id, "RUNNING");
    await expect(fixtures.run(b.id, user.id, "RUNNING")).resolves.toBeDefined();
  });

  it("lets exactly one of many concurrent inserts win", async () => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => fixtures.run(chat.id, user.id, "PENDING")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.agentRun.count({ where: { chatId: chat.id, status: "PENDING" } })).toBe(1);
  });
});

describe("message idempotency key", () => {
  it("rejects a duplicate (chatId, clientMessageId)", async () => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    await fixtures.message(chat.id, user.id, { clientMessageId: "k1" });
    expect(await failure(fixtures.message(chat.id, user.id, { clientMessageId: "k1" }))).toBe("P2002");
  });

  it("allows many messages without a clientMessageId", async () => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    await fixtures.message(chat.id, user.id);
    await expect(fixtures.message(chat.id, user.id)).resolves.toBeDefined();
  });

  it("allows the same clientMessageId in different chats", async () => {
    const user = await fixtures.user();
    const [a, b] = [await fixtures.chat(user.id), await fixtures.chat(user.id)];
    await fixtures.message(a.id, user.id, { clientMessageId: "k1" });
    await expect(fixtures.message(b.id, user.id, { clientMessageId: "k1" })).resolves.toBeDefined();
  });
});

describe("run bookkeeping", () => {
  it("links an assistant message to at most one run", async () => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    const run = await fixtures.run(chat.id, user.id, "COMPLETED");
    const trigger = await fixtures.message(chat.id, user.id);
    const duplicate = prisma.agentRun.create({
      data: { chatId: chat.id, userId: user.id, triggerMessageId: trigger.id, assistantMessageId: run.assistantMessageId, traceId: "t" },
    });
    expect(await failure(duplicate)).toBe("P2002");
  });

  it("allows one user message to trigger a second run after the first finished", async () => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    const first = await fixtures.run(chat.id, user.id, "FAILED");
    const assistant = await fixtures.message(chat.id, user.id, { role: "ASSISTANT" });
    await expect(
      prisma.agentRun.create({
        data: { chatId: chat.id, userId: user.id, triggerMessageId: first.triggerMessageId, assistantMessageId: assistant.id, traceId: "t2" },
      }),
    ).resolves.toBeDefined();
  });

  it("keeps triggerRunId unique but lets many runs have none", async () => {
    const user = await fixtures.user();
    const [a, b, c] = [await fixtures.chat(user.id), await fixtures.chat(user.id), await fixtures.chat(user.id)];
    const [r1, r2] = [await fixtures.run(a.id, user.id), await fixtures.run(b.id, user.id)];
    await fixtures.run(c.id, user.id); // a third run without a triggerRunId: NULLs do not collide
    await prisma.agentRun.update({ where: { id: r1.id }, data: { triggerRunId: "run_abc" } });
    expect(await failure(prisma.agentRun.update({ where: { id: r2.id }, data: { triggerRunId: "run_abc" } }))).toBe("P2002");
  });

  it("rejects a tool call recorded twice for one run", async () => {
    const user = await fixtures.user();
    const run = await fixtures.run((await fixtures.chat(user.id)).id, user.id);
    const tool = { agentRunId: run.id, toolCallId: "call_1", toolName: "crop_image", input: {} };
    await prisma.toolInvocation.create({ data: tool });
    expect(await failure(prisma.toolInvocation.create({ data: tool }))).toBe("P2002");
  });
});

describe("cascades and foreign keys", () => {
  it("deleting a chat removes its messages and runs but keeps ledger rows", async () => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    const run = await fixtures.run(chat.id, user.id, "RUNNING");
    await prisma.toolInvocation.create({ data: { agentRunId: run.id, toolCallId: "c", toolName: "t", input: {} } });
    const entry = await ledger(user.id, { agentRunId: run.id, type: "HOLD" });

    await prisma.chat.delete({ where: { id: chat.id } });

    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.agentRun.count()).toBe(0);
    expect(await prisma.toolInvocation.count()).toBe(0);
    expect(await prisma.creditLedger.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ agentRunId: null });
  });

  it("deleting a chat frees nothing else: another chat's data is untouched", async () => {
    const user = await fixtures.user();
    const [a, b] = [await fixtures.chat(user.id), await fixtures.chat(user.id)];
    await fixtures.run(a.id, user.id);
    await fixtures.run(b.id, user.id);
    await prisma.chat.delete({ where: { id: a.id } });
    expect(await prisma.agentRun.count({ where: { chatId: b.id } })).toBe(1);
  });

  it("deleting a user removes everything they own", async () => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    await fixtures.run(chat.id, user.id);
    await ledger(user.id);
    await prisma.user.delete({ where: { id: user.id } });
    const counts = await Promise.all([prisma.chat.count(), prisma.message.count(), prisma.agentRun.count(), prisma.creditLedger.count()]);
    expect(counts).toEqual([0, 0, 0, 0]);
  });

  it("rejects rows that reference a missing parent", async () => {
    const user = await fixtures.user();
    expect(await failure(prisma.chat.create({ data: { userId: "nobody" } }))).toBe("P2003");
    expect(await failure(fixtures.message("missing_chat", user.id))).toBe("P2003");
  });
});

describe("credit ledger", () => {
  it("rejects a duplicate idempotencyKey", async () => {
    const user = await fixtures.user();
    await ledger(user.id, { idempotencyKey: "hold:run1" });
    expect(await failure(ledger(user.id, { idempotencyKey: "hold:run1" }))).toBe("P2002");
  });

  it("rejects a zero amount", async () => {
    const user = await fixtures.user();
    expect(await rejection(ledger(user.id, { amount: 0 }))).toContain("CreditLedger_amount_nonzero");
  });
});

describe("user credit invariants (CHECK constraint)", () => {
  it.each([
    ["negative balance", { balance: -1 }],
    ["negative held", { held: -1 }],
    ["held above balance", { balance: 10, held: 11 }],
  ])("rejects %s", async (_label, data) => {
    expect(await rejection(fixtures.user(data))).toContain("User_credits_valid");
  });

  it("allows held equal to balance (fully reserved)", async () => {
    await expect(fixtures.user({ balance: 500, held: 500 })).resolves.toBeDefined();
  });

  it("rejects an update that would over-hold, leaving the row unchanged", async () => {
    const user = await fixtures.user({ balance: 100, held: 0 });
    expect(await rejection(prisma.user.update({ where: { id: user.id }, data: { held: 101 } }))).toContain("User_credits_valid");
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ balance: 100, held: 0 });
  });

  it("stores the largest 32-bit balance and rejects one more", async () => {
    await expect(fixtures.user({ balance: 2_147_483_647 })).resolves.toBeDefined();
    expect(await failure(fixtures.user({ balance: 2_147_483_648 }))).not.toBe("no error");
  });
});

describe("column defaults", () => {
  it("gives new chats a title, no pin and a non-null lastMessageAt", async () => {
    const chat = await fixtures.chat((await fixtures.user()).id);
    expect(chat).toMatchObject({ title: "New chat", isPinned: false });
    expect(chat.lastMessageAt).toBeInstanceOf(Date);
  });

  it("defaults contentBlocks to an empty array and round-trips nested JSON", async () => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    expect((await fixtures.message(chat.id, user.id)).contentBlocks).toEqual([]);
    const blocks = [{ type: "text", content: "héllo \u{1F600}" }, { type: "thinking", content: "", durationMs: 0 }];
    const saved = await prisma.message.create({ data: { chatId: chat.id, userId: user.id, role: "ASSISTANT", contentBlocks: blocks } });
    expect(saved.contentBlocks).toEqual(blocks);
  });

  it("allows a missing email but keeps non-null emails unique", async () => {
    await prisma.user.create({ data: { id: "a" } });
    await prisma.user.create({ data: { id: "b" } });
    await prisma.user.create({ data: { id: "c", email: "x@y.z" } });
    expect(await failure(prisma.user.create({ data: { id: "d", email: "x@y.z" } }))).toBe("P2002");
  });
});

describe("keyset indexes", () => {
  it("serves the newest-first message page from the (chatId, createdAt, id) index", async () => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    await fixtures.message(chat.id, user.id);
    const plan = await prisma.$transaction(async (tx) => {
      // Forbid every other way to produce this ordering, so the plan only succeeds if the index can serve it.
      for (const knob of ["enable_seqscan", "enable_bitmapscan", "enable_sort"]) {
        await tx.$executeRawUnsafe(`SET LOCAL ${knob} = off`);
      }
      const rows = await tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN SELECT id FROM "Message" WHERE "chatId" = '${chat.id}' ORDER BY "createdAt" DESC, id DESC LIMIT 50`,
      );
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("Message_chatId_createdAt_id_idx");
    expect(plan).not.toMatch(/\bSort\b/);
  });
});
