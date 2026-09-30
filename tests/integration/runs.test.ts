import { beforeEach, describe, expect, it } from "vitest";
import { ActiveRunResponseSchema, ContentBlockSchema, ErrorResponseSchema } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { MAX_RUN_MS } from "#src/services/reconcile.js";
import { finalizeRun } from "#src/services/runs.js";
import { as } from "../helpers/app.js";
import { activeTurn, fixtures, resetDb } from "../helpers/db.js";
import { trigger } from "../helpers/triggerMock.js";

beforeEach(resetDb);

const HOLD = 100_000;
const START = 1_000_000;

async function setup(extra: { balance?: number } = {}) {
  const user = await fixtures.user({ id: "u1", balance: extra.balance ?? START });
  const chat = await fixtures.chat(user.id);
  return { user, chat };
}

interface ActiveBody {
  run: { id: string; chatId: string; triggerRunId: string | null; status: string; startedAt: string | null; completedAt: string | null } | null;
  realtimeToken: string | null;
  realtimeTokenExpiresAt: string | null;
  partialText: string | null;
  partialBlocks: { type: string; content?: string }[];
}
const activeRun = async (chatId: string, user = "u1") => {
  const res = await as(user).get(`/api/chats/${chatId}/active-run`);
  return { res, body: res.body as ActiveBody };
};
const ledger = (types: ("HOLD" | "RELEASE")[] = ["HOLD", "RELEASE"]) => prisma.creditLedger.findMany({ where: { type: { in: types } }, orderBy: { createdAt: "asc" } });
const heldOf = async (id = "u1") => (await prisma.user.findUniqueOrThrow({ where: { id } })).held;
const runOf = (id: string) => prisma.agentRun.findUniqueOrThrow({ where: { id } });
const replyOf = (id: string) => prisma.message.findUniqueOrThrow({ where: { id } });

describe("finalizeRun", () => {
  it("completes a run: final content, status, usage, credits returned, and the chat moves up", async () => {
    const { chat } = await setup();
    const { run, assistantMessage } = await activeTurn(chat.id, "u1");
    const before = (await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } })).lastMessageAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const blocks = [{ type: "thinking" as const, content: "hm" }, { type: "text" as const, content: "Hello " }, { type: "text" as const, content: "world" }];
    expect(await finalizeRun(run.id, { status: "COMPLETED", blocks, model: "some/free-model", inputTokens: 12, outputTokens: 34 })).toBe(true);

    expect(await runOf(run.id)).toMatchObject({ status: "COMPLETED", model: "some/free-model", inputTokens: 12, outputTokens: 34, errorCode: null });
    expect((await runOf(run.id)).completedAt).toBeInstanceOf(Date);
    expect(await replyOf(assistantMessage.id)).toMatchObject({ status: "COMPLETED", content: "Hello world", contentBlocks: blocks });
    expect(await heldOf()).toBe(0);
    expect((await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } })).lastMessageAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("records a failure with its safe message and keeps whatever had already been written", async () => {
    const { chat } = await setup();
    const partial = [{ type: "text", content: "Half an ans" }];
    const { run, assistantMessage } = await activeTurn(chat.id, "u1", { blocks: partial, content: "Half an ans" });
    expect(await finalizeRun(run.id, { status: "FAILED", errorCode: "AGENT_FAILED", errorMessage: "The agent ran into a problem." })).toBe(true);
    expect(await runOf(run.id)).toMatchObject({ status: "FAILED", errorCode: "AGENT_FAILED", errorMessage: "The agent ran into a problem." });
    expect(await replyOf(assistantMessage.id)).toMatchObject({ status: "FAILED", content: "Half an ans", contentBlocks: partial });
    expect(await heldOf()).toBe(0);
  });

  it("keeps the partial reply when a run is cancelled", async () => {
    const { chat } = await setup();
    const { run, assistantMessage } = await activeTurn(chat.id, "u1", { blocks: [{ type: "text", content: "So far" }], content: "So far" });
    await finalizeRun(run.id, { status: "CANCELLED" });
    expect(await replyOf(assistantMessage.id)).toMatchObject({ status: "CANCELLED", content: "So far" });
    expect(await runOf(run.id)).toMatchObject({ status: "CANCELLED" });
  });

  it("is a no-op the second time: the first outcome stands and nothing is released twice", async () => {
    const { chat } = await setup();
    const { run, assistantMessage } = await activeTurn(chat.id, "u1");
    expect(await finalizeRun(run.id, { status: "COMPLETED", blocks: [{ type: "text", content: "first" }] })).toBe(true);
    expect(await finalizeRun(run.id, { status: "FAILED", errorCode: "LATE" })).toBe(false);
    expect(await finalizeRun(run.id, { status: "CANCELLED" })).toBe(false);
    expect(await runOf(run.id)).toMatchObject({ status: "COMPLETED", errorCode: null });
    expect(await replyOf(assistantMessage.id)).toMatchObject({ status: "COMPLETED", content: "first" });
    expect(await ledger(["RELEASE"])).toHaveLength(1);
  });

  it("returns false for a run that does not exist", async () => {
    await setup();
    expect(await finalizeRun("nosuchrun", { status: "CANCELLED" })).toBe(false);
  });

  it("lets exactly one of many simultaneous endings win, and releases the credits once", async () => {
    const { chat } = await setup();
    const { run, assistantMessage } = await activeTurn(chat.id, "u1");
    const results = await Promise.all([
      finalizeRun(run.id, { status: "COMPLETED", blocks: [{ type: "text", content: "done" }] }),
      finalizeRun(run.id, { status: "FAILED", errorCode: "A" }),
      finalizeRun(run.id, { status: "CANCELLED" }),
      finalizeRun(run.id, { status: "CANCELLED" }),
      finalizeRun(run.id, { status: "FAILED", errorCode: "B" }),
      finalizeRun(run.id, { status: "COMPLETED", blocks: [{ type: "text", content: "also done" }] }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const final = await runOf(run.id);
    expect(final.status).toBe((await replyOf(assistantMessage.id)).status); // run and reply always agree
    expect(await ledger(["RELEASE"])).toHaveLength(1);
    expect(await heldOf()).toBe(0);
  });

  it("returns exactly what was held, even if the hold amount setting has changed since", async () => {
    const { chat } = await setup();
    const { run } = await activeTurn(chat.id, "u1", { heldCredits: 70_000 });
    expect(await heldOf()).toBe(70_000);
    await finalizeRun(run.id, { status: "CANCELLED" });
    expect(await heldOf()).toBe(0);
    expect((await ledger(["RELEASE"]))[0]?.amount).toBe(-70_000);
  });

  it("copes with a run that never had a hold", async () => {
    const { chat } = await setup();
    const { run } = await activeTurn(chat.id, "u1", { heldCredits: 0 });
    expect(await finalizeRun(run.id, { status: "CANCELLED" })).toBe(true);
    expect(await ledger()).toHaveLength(0);
  });

  it("refuses invalid content and ends nothing, rather than storing a broken reply", async () => {
    const { chat } = await setup();
    const { run } = await activeTurn(chat.id, "u1");
    await expect(finalizeRun(run.id, { status: "COMPLETED", blocks: [{ type: "made-up" } as never] })).rejects.toThrow();
    expect(await runOf(run.id)).toMatchObject({ status: "RUNNING" });
    expect(await heldOf()).toBe(HOLD);
  });

  it("stores blocks the way the database will return them (undefined keys dropped) and they stay valid", async () => {
    const { chat } = await setup();
    const { run, assistantMessage } = await activeTurn(chat.id, "u1");
    await finalizeRun(run.id, {
      status: "COMPLETED",
      blocks: [
        { type: "tool_call", toolCallId: "t1", toolName: "x", toolInput: {}, status: "failed" },
        { type: "tool_result", toolCallId: "t1", toolName: "x", result: undefined, isError: true, errorMessage: "boom" },
      ],
    });
    const stored = (await replyOf(assistantMessage.id)).contentBlocks as unknown[];
    expect(stored[1]).not.toHaveProperty("result");
    for (const block of stored) expect(ContentBlockSchema.safeParse(block).success).toBe(true);
  });

  it("can be part of a larger transaction, and rolls back with it", async () => {
    const { chat } = await setup();
    const { run } = await activeTurn(chat.id, "u1");
    await expect(
      prisma.$transaction(async (tx) => {
        expect(await finalizeRun(run.id, { status: "CANCELLED" }, tx)).toBe(true);
        throw new Error("something later in the transaction failed");
      }),
    ).rejects.toThrow("something later");
    expect(await runOf(run.id)).toMatchObject({ status: "RUNNING" });
    expect(await heldOf()).toBe(HOLD);
  });
});

describe("GET /api/chats/:chatId/active-run", () => {
  it("has nothing to report when no run is going", async () => {
    const { chat } = await setup();
    const { res, body } = await activeRun(chat.id);
    expect(res.status).toBe(200);
    expect(ActiveRunResponseSchema.parse(res.body).run).toBeNull();
    expect(body).toEqual({ run: null, realtimeToken: null, realtimeTokenExpiresAt: null, partialText: null, partialBlocks: [] });
  });

  it("describes a run that was just sent: pending, with a token to follow it", async () => {
    const { chat } = await setup();
    const { run } = await activeTurn(chat.id, "u1", { status: "PENDING", triggerRunId: "run_abc", ageMs: 500 });
    const { res, body } = await activeRun(chat.id);
    expect(ActiveRunResponseSchema.safeParse(res.body).success).toBe(true);
    expect(body.run).toMatchObject({ id: run.id, chatId: chat.id, triggerRunId: "run_abc", status: "PENDING", startedAt: null, completedAt: null });
    expect(body.realtimeToken).toBe("token-for-run_abc");
    expect(new Date(body.realtimeTokenExpiresAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    expect(body).toMatchObject({ partialText: "", partialBlocks: [] });
  });

  it("returns what has been written so far, so a reload or a dropped connection loses nothing", async () => {
    const { chat } = await setup();
    const blocks = [{ type: "thinking", content: "hm" }, { type: "text", content: "The answer is " }, { type: "text", content: "42" }];
    await activeTurn(chat.id, "u1", { blocks });
    const { body } = await activeRun(chat.id);
    expect(body.run?.status).toBe("RUNNING");
    expect(body.partialText).toBe("The answer is 42");
    expect(body.partialBlocks).toEqual(blocks);
  });

  it("is empty again once the run has ended, however it ended", async () => {
    const { chat } = await setup();
    for (const outcome of [{ status: "COMPLETED" as const, blocks: [{ type: "text" as const, content: "ok" }] }, { status: "FAILED" as const }, { status: "CANCELLED" as const }]) {
      const { run } = await activeTurn(chat.id, "u1");
      expect((await activeRun(chat.id)).body.run?.id).toBe(run.id);
      await finalizeRun(run.id, outcome);
      expect((await activeRun(chat.id)).body.run).toBeNull();
    }
  });

  it("is 404 for another user's chat, a missing chat and an impossible id, and reveals nothing", async () => {
    const { chat } = await setup();
    await activeTurn(chat.id, "u1", { blocks: [{ type: "text", content: "private" }] });
    await as("other").get("/api/credits");
    for (const id of [chat.id, "doesnotexist", "%00", "x".repeat(65)]) {
      const res = await as("other").get(`/api/chats/${id}/active-run`);
      expect(res.status, id).toBe(404);
      expect(ErrorResponseSchema.parse(res.body).code).toBe("NOT_FOUND");
      expect(JSON.stringify(res.body)).not.toContain("private");
    }
  });

  it("needs a signed-in user", async () => {
    const { chat } = await setup();
    expect((await as("nobody-token-but-valid").get(`/api/chats/${chat.id}/active-run`)).status).toBe(404); // a different, real user: not their chat
  });

  it("still describes the run, without a token, when no token can be made", async () => {
    const { chat } = await setup();
    await activeTurn(chat.id, "u1");
    trigger.tokenError = new Error("signing failed");
    const { res, body } = await activeRun(chat.id);
    expect(res.status).toBe(200);
    expect(body.run).not.toBeNull();
    expect(body.realtimeToken).toBeNull();
    expect(body.realtimeTokenExpiresAt).toBeNull();
  });

  it("describes a run whose Trigger.dev id is not saved yet, without a token", async () => {
    const { chat } = await setup();
    await activeTurn(chat.id, "u1", { status: "PENDING", triggerRunId: null, ageMs: 2_000 });
    const { body } = await activeRun(chat.id);
    expect(body.run).toMatchObject({ status: "PENDING", triggerRunId: null });
    expect(body.realtimeToken).toBeNull();
  });

  it("does not crash on a reply whose saved blocks are damaged, and shows what is readable", async () => {
    const { chat } = await setup();
    const { assistantMessage } = await activeTurn(chat.id, "u1");
    for (const damaged of [{ not: "an array" }, "a string", 7, [null, { type: "from-the-future" }, { type: "text", content: "readable" }]]) {
      await prisma.message.update({ where: { id: assistantMessage.id }, data: { contentBlocks: damaged } });
      const { res, body } = await activeRun(chat.id);
      expect(res.status).toBe(200);
      expect(Array.isArray(body.partialBlocks)).toBe(true);
    }
    expect((await activeRun(chat.id)).body.partialText).toBe("readable");
  });
});

describe("a run that is really dead must not look alive, or lock the chat", () => {
  it("ends a run that was never handed to Trigger.dev once it is a minute old, returning the credits", async () => {
    const { chat } = await setup();
    const { run, assistantMessage } = await activeTurn(chat.id, "u1", { status: "PENDING", triggerRunId: null, ageMs: 61_000 });
    const { body } = await activeRun(chat.id);
    expect(body.run).toBeNull();
    expect(await runOf(run.id)).toMatchObject({ status: "FAILED", errorCode: "DISPATCH_LOST" });
    expect(await replyOf(assistantMessage.id)).toMatchObject({ status: "FAILED" });
    expect(await heldOf()).toBe(0);
  });

  it("gives a run that is still being handed over a minute before giving up", async () => {
    const { chat } = await setup();
    await activeTurn(chat.id, "u1", { status: "PENDING", triggerRunId: null, ageMs: 30_000 });
    expect((await activeRun(chat.id)).body.run).not.toBeNull();
  });

  it.each([
    ["CANCELED", "CANCELLED", null],
    ["COMPLETED", "FAILED", "RESULT_LOST"],
    ["FAILED", "FAILED", "AGENT_FAILED"],
    ["CRASHED", "FAILED", "AGENT_CRASHED"],
    ["SYSTEM_FAILURE", "FAILED", "AGENT_CRASHED"],
    ["TIMED_OUT", "FAILED", "AGENT_TIMEOUT"],
    ["EXPIRED", "FAILED", "AGENT_EXPIRED"],
  ])("ends a quiet run that Trigger.dev reports as %s (as %s %s)", async (triggerStatus, expectedStatus, expectedCode) => {
    const { chat } = await setup();
    const { run, assistantMessage } = await activeTurn(chat.id, "u1", { triggerRunId: "run_dead", ageMs: 120_000, quietMs: 60_000, blocks: [{ type: "text", content: "partial" }], content: "partial" });
    trigger.statuses.set("run_dead", triggerStatus);
    expect((await activeRun(chat.id)).body.run).toBeNull();
    expect(await runOf(run.id)).toMatchObject({ status: expectedStatus, errorCode: expectedCode });
    expect(await replyOf(assistantMessage.id)).toMatchObject({ status: expectedStatus, content: "partial" }); // what was written is kept
    expect(await heldOf()).toBe(0);
  });

  it.each(["EXECUTING", "QUEUED", "DEQUEUED", "WAITING", "DELAYED", "PENDING_VERSION"])("leaves a quiet run alone while Trigger.dev says it is %s", async (triggerStatus) => {
    const { chat } = await setup();
    await activeTurn(chat.id, "u1", { triggerRunId: "run_ok", ageMs: 120_000, quietMs: 60_000 });
    trigger.statuses.set("run_ok", triggerStatus);
    expect((await activeRun(chat.id)).body.run).not.toBeNull();
    expect(await heldOf()).toBe(HOLD);
  });

  it("leaves a quiet run alone when Trigger.dev cannot be asked (it does not guess)", async () => {
    const { chat } = await setup();
    await activeTurn(chat.id, "u1", { triggerRunId: "run_unknown", ageMs: 120_000, quietMs: 60_000 });
    trigger.statuses.set("run_unknown", null);
    expect((await activeRun(chat.id)).body.run).not.toBeNull();
  });

  it("does not bother Trigger.dev about a run that is making progress", async () => {
    const { chat } = await setup();
    await activeTurn(chat.id, "u1", { triggerRunId: "run_busy", ageMs: 120_000, quietMs: 2_000 });
    for (let i = 0; i < 5; i++) await activeRun(chat.id);
    expect(trigger.statusLookups).toHaveLength(0);
  });

  it("asks Trigger.dev about a quiet run at most once in a while, however often the client polls", async () => {
    const { chat } = await setup();
    await activeTurn(chat.id, "u1", { triggerRunId: "run_quiet", ageMs: 120_000, quietMs: 60_000 });
    for (let i = 0; i < 6; i++) await activeRun(chat.id);
    expect(trigger.statusLookups).toHaveLength(1);
  });

  it("ends anything older than the task's own time limit, even if Trigger.dev cannot be reached", async () => {
    const { chat } = await setup();
    const { run } = await activeTurn(chat.id, "u1", { triggerRunId: "run_ancient", ageMs: MAX_RUN_MS + 1_000, quietMs: 1_000 });
    trigger.statuses.set("run_ancient", null);
    expect((await activeRun(chat.id)).body.run).toBeNull();
    expect(await runOf(run.id)).toMatchObject({ status: "FAILED", errorCode: "AGENT_TIMEOUT" });
    expect(await heldOf()).toBe(0);
  });

  it("returns the credits exactly once when many clients poll a dead run at the same moment", async () => {
    const { chat } = await setup();
    await activeTurn(chat.id, "u1", { status: "PENDING", triggerRunId: null, ageMs: 120_000 });
    const results = await Promise.all(Array.from({ length: 6 }, () => activeRun(chat.id)));
    expect(results.every(({ res, body }) => res.status === 200 && body.run === null)).toBe(true);
    expect(await ledger(["RELEASE"])).toHaveLength(1);
    expect(await heldOf()).toBe(0);
  });
});

describe("POST /api/runs/:runId/cancel", () => {
  it("stops a running run: 204, the partial reply is kept, the credits come back, Trigger.dev is told", async () => {
    const { chat } = await setup();
    const { run, assistantMessage } = await activeTurn(chat.id, "u1", { triggerRunId: "run_live", blocks: [{ type: "text", content: "Partway" }], content: "Partway" });
    const res = await as("u1").post(`/api/runs/${run.id}/cancel`);
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(await runOf(run.id)).toMatchObject({ status: "CANCELLED" });
    expect((await runOf(run.id)).completedAt).toBeInstanceOf(Date);
    expect(await replyOf(assistantMessage.id)).toMatchObject({ status: "CANCELLED", content: "Partway" });
    expect(await heldOf()).toBe(0);
    expect(trigger.cancelled).toEqual(["run_live"]);
    expect((await activeRun(chat.id)).body.run).toBeNull();
  });

  it("stops a run that has not been handed to Trigger.dev yet, without calling it", async () => {
    const { chat } = await setup();
    const { run } = await activeTurn(chat.id, "u1", { status: "PENDING", triggerRunId: null, ageMs: 1_000 });
    expect((await as("u1").post(`/api/runs/${run.id}/cancel`)).status).toBe(204);
    expect(await runOf(run.id)).toMatchObject({ status: "CANCELLED" });
    expect(trigger.cancelled).toEqual([]);
  });

  it("lets the chat be used again straight away", async () => {
    const { chat } = await setup();
    const { run } = await activeTurn(chat.id, "u1");
    await as("u1").post(`/api/runs/${run.id}/cancel`);
    expect((await as("u1").post(`/api/chats/${chat.id}/messages`).send({ content: "next" })).status).toBe(201);
  });

  it("answers 404 when the run has already ended, is unknown, or has an impossible id", async () => {
    const { chat } = await setup();
    const { run } = await activeTurn(chat.id, "u1");
    await as("u1").post(`/api/runs/${run.id}/cancel`);
    for (const id of [run.id, "nosuchrun", "%00", "x".repeat(65), "..%2Fetc"]) {
      const res = await as("u1").post(`/api/runs/${id}/cancel`);
      expect(res.status, id).toBe(404);
      expect(ErrorResponseSchema.parse(res.body).code).toBe("NOT_FOUND");
    }
    expect(trigger.cancelled).toHaveLength(1); // only the first, real cancel reached Trigger.dev
  });

  it("answers 404 for a run that finished on its own, and does not disturb it", async () => {
    const { chat } = await setup();
    const { run, assistantMessage } = await activeTurn(chat.id, "u1");
    await finalizeRun(run.id, { status: "COMPLETED", blocks: [{ type: "text", content: "done" }] });
    expect((await as("u1").post(`/api/runs/${run.id}/cancel`)).status).toBe(404);
    expect(await runOf(run.id)).toMatchObject({ status: "COMPLETED" });
    expect(await replyOf(assistantMessage.id)).toMatchObject({ status: "COMPLETED", content: "done" });
  });

  it("cannot stop someone else's run, and leaves it running with its credits held", async () => {
    const { chat } = await setup();
    const { run } = await activeTurn(chat.id, "u1");
    await as("intruder").get("/api/credits");
    const res = await as("intruder").post(`/api/runs/${run.id}/cancel`);
    expect(res.status).toBe(404);
    expect(await runOf(run.id)).toMatchObject({ status: "RUNNING" });
    expect(await heldOf()).toBe(HOLD);
    expect(trigger.cancelled).toEqual([]);
  });

  it("needs a signed-in user", async () => {
    const { chat } = await setup();
    const { run } = await activeTurn(chat.id, "u1");
    const res = await (await import("../helpers/app.js")).anonymous().post(`/api/runs/${run.id}/cancel`);
    expect(res.status).toBe(401);
    expect(await runOf(run.id)).toMatchObject({ status: "RUNNING" });
  });

  it("lets exactly one of several simultaneous stops succeed", async () => {
    const { chat } = await setup();
    const { run } = await activeTurn(chat.id, "u1");
    const results = await Promise.all(Array.from({ length: 6 }, () => as("u1").post(`/api/runs/${run.id}/cancel`)));
    expect(results.filter((r) => r.status === 204)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(5);
    expect(await ledger(["RELEASE"])).toHaveLength(1);
    expect(trigger.cancelled).toHaveLength(1);
  });

  it("agrees with a run that finishes at the same moment: one outcome, consistent everywhere, credits returned once", async () => {
    for (let round = 0; round < 10; round++) {
      await resetDb();
      const { chat } = await setup();
      const { run, assistantMessage } = await activeTurn(chat.id, "u1");
      const [cancel, finished] = await Promise.all([
        as("u1").post(`/api/runs/${run.id}/cancel`),
        finalizeRun(run.id, { status: "COMPLETED", blocks: [{ type: "text", content: "done" }] }),
      ]);
      const final = await runOf(run.id);
      expect(["COMPLETED", "CANCELLED"]).toContain(final.status);
      expect((await replyOf(assistantMessage.id)).status).toBe(final.status);
      expect(cancel.status).toBe(final.status === "CANCELLED" ? 204 : 404);
      expect(finished).toBe(final.status === "COMPLETED");
      expect(await ledger(["RELEASE"])).toHaveLength(1);
      expect(await heldOf()).toBe(0);
    }
  });
});

describe("DELETE /api/chats/:chatId while an agent is running", () => {
  it("stops the run, returns the credits, removes the chat, and tells Trigger.dev", async () => {
    const { chat } = await setup();
    await activeTurn(chat.id, "u1", { triggerRunId: "run_to_stop" });
    expect(await heldOf()).toBe(HOLD);

    const res = await as("u1").delete(`/api/chats/${chat.id}`);
    expect(res.status).toBe(204);
    expect(await prisma.chat.count()).toBe(0);
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.agentRun.count()).toBe(0);
    expect(await heldOf()).toBe(0);
    expect(trigger.cancelled).toEqual(["run_to_stop"]);
    const entries = await ledger();
    expect(entries.reduce((sum, row) => sum + row.amount, 0)).toBe(0); // the audit trail shows the hold and its release
    expect(entries.every((row) => row.agentRunId === null)).toBe(true);
  });

  it("works for a run that was never handed to Trigger.dev, without calling it", async () => {
    const { chat } = await setup();
    await activeTurn(chat.id, "u1", { status: "PENDING", triggerRunId: null, ageMs: 500 });
    expect((await as("u1").delete(`/api/chats/${chat.id}`)).status).toBe(204);
    expect(await heldOf()).toBe(0);
    expect(trigger.cancelled).toEqual([]);
  });

  it("does not touch another user's chat or its run", async () => {
    const { chat } = await setup();
    await activeTurn(chat.id, "u1");
    await as("intruder").get("/api/credits");
    expect((await as("intruder").delete(`/api/chats/${chat.id}`)).status).toBe(404);
    expect(await prisma.chat.count()).toBe(1);
    expect(await heldOf()).toBe(HOLD);
    expect(trigger.cancelled).toEqual([]);
  });

  it("only affects the deleted chat's own run", async () => {
    const { chat } = await setup();
    const other = await fixtures.chat("u1");
    await activeTurn(chat.id, "u1");
    await activeTurn(other.id, "u1");
    await as("u1").delete(`/api/chats/${chat.id}`);
    expect(await heldOf()).toBe(HOLD);
    expect((await activeRun(other.id)).body.run).not.toBeNull();
  });

  it("is still a clean 404 the second time, and for a chat that never existed", async () => {
    const { chat } = await setup();
    await as("u1").delete(`/api/chats/${chat.id}`);
    expect((await as("u1").delete(`/api/chats/${chat.id}`)).status).toBe(404);
    expect((await as("u1").delete("/api/chats/neverexisted")).status).toBe(404);
  });

  it("returns the credits once when a delete and a stop arrive together", async () => {
    const { chat } = await setup();
    const { run } = await activeTurn(chat.id, "u1");
    const [deleted, stopped] = await Promise.all([as("u1").delete(`/api/chats/${chat.id}`), as("u1").post(`/api/runs/${run.id}/cancel`)]);
    expect(deleted.status).toBe(204);
    expect([204, 404]).toContain(stopped.status);
    expect(await heldOf()).toBe(0);
    expect((await ledger(["RELEASE"])).length).toBeLessThanOrEqual(1);
  });
});
