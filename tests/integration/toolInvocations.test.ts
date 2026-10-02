import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "#src/db/client.js";
import { completeInvocation, createInvocation, endInvocation, InsufficientCreditsForTool, markDispatching, markRunning, turnToolCost } from "#src/services/toolInvocations.js";
import { finalizeRun } from "#src/services/runs.js";
import { as } from "../helpers/app.js";
import { activeTurn, fixtures, resetDb } from "../helpers/db.js";

beforeEach(resetDb);

const COST = 1_000_000;

async function aRun(balance = 10_000_000) {
  const user = await fixtures.user({ balance });
  const chat = await fixtures.chat(user.id);
  const run = await fixtures.run(chat.id, user.id, "RUNNING");
  return { user, run };
}
const call = (agentRunId: string, userId: string, toolCallId = "call_1", creditCost = COST) => ({ agentRunId, userId, toolCallId, toolName: "gpt_image_2", input: { mode: "text", prompt: "A fox" }, creditCost });
const credits = async (id: string) => prisma.user.findUniqueOrThrow({ where: { id }, select: { balance: true, held: true } });
const ledger = (userId: string) => prisma.creditLedger.findMany({ where: { userId, type: { not: "GRANT" } }, orderBy: { createdAt: "asc" }, select: { type: true, amount: true, idempotencyKey: true } });

async function errorOf(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("recording a tool call", () => {
  it("writes the call as PENDING with its input and reserves its credits, together", async () => {
    const { user, run } = await aRun();
    const invocation = await createInvocation(call(run.id, user.id));
    expect(invocation).toMatchObject({ agentRunId: run.id, toolCallId: "call_1", toolName: "gpt_image_2", status: "PENDING", input: { mode: "text", prompt: "A fox" } });
    expect(await credits(user.id)).toEqual({ balance: 10_000_000, held: COST });
    expect(await ledger(user.id)).toEqual([{ type: "HOLD", amount: COST, idempotencyKey: `tool-hold:${invocation.id}` }]);
  });

  it("gives back the same call when asked twice, reserving once", async () => {
    const { user, run } = await aRun();
    const first = await createInvocation(call(run.id, user.id));
    const again = await createInvocation(call(run.id, user.id));
    expect(again.id).toBe(first.id);
    expect((await credits(user.id)).held).toBe(COST);
  });

  it("records one call and one reservation when the same call arrives several times at once", async () => {
    const { user, run } = await aRun();
    const results = await Promise.all(Array.from({ length: 6 }, () => createInvocation(call(run.id, user.id))));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await prisma.toolInvocation.count()).toBe(1);
    expect((await credits(user.id)).held).toBe(COST);
  });

  it("writes nothing when the user can't afford it", async () => {
    const { user, run } = await aRun(COST - 1);
    expect(await errorOf(createInvocation(call(run.id, user.id)))).toBeInstanceOf(InsufficientCreditsForTool);
    expect(await prisma.toolInvocation.count()).toBe(0);
    expect(await credits(user.id)).toEqual({ balance: COST - 1, held: 0 });
  });

  it("counts credits already reserved: two calls that each fit, but not together, can't both be reserved", async () => {
    const { user, run } = await aRun(COST + COST / 2);
    const results = await Promise.allSettled([createInvocation(call(run.id, user.id, "a")), createInvocation(call(run.id, user.id, "b"))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected" && r.reason instanceof InsufficientCreditsForTool)).toHaveLength(1);
    expect(await credits(user.id)).toEqual({ balance: COST + COST / 2, held: COST });
  });

  it("reserves nothing for a free tool", async () => {
    const { user, run } = await aRun();
    await createInvocation({ ...call(run.id, user.id), toolName: "load_skill", creditCost: 0 });
    expect(await ledger(user.id)).toEqual([]);
  });
});

describe("the call's lifecycle", () => {
  it("moves PENDING -> DISPATCHING (once) -> RUNNING with Magica's run id", async () => {
    const { user, run } = await aRun();
    const { id } = await createInvocation(call(run.id, user.id));
    expect(await markRunning(id, "mg_1")).toBe(false); // not before it was sent
    expect(await markDispatching(id)).toBe(true);
    expect(await markDispatching(id)).toBe(false); // a second attempt can't take it
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id } })).dispatchedAt).toBeInstanceOf(Date);
    expect(await markRunning(id, "mg_1")).toBe(true);
    expect(await markRunning(id, "mg_1")).toBe(true); // saving the id again is harmless
    expect(await prisma.toolInvocation.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "RUNNING", magicaRunId: "mg_1" });
  });
});

describe("settling", () => {
  async function running() {
    const { user, run } = await aRun();
    const invocation = await createInvocation(call(run.id, user.id));
    await markDispatching(invocation.id);
    await markRunning(invocation.id, "mg_1");
    return { user, run, invocation };
  }

  it("charges a completed call exactly once: the reservation becomes a charge", async () => {
    const { user, invocation } = await running();
    expect(await completeInvocation(invocation.id, { output: { images: [{ url: "https://a.test/1.png" }] }, durationMs: 31_500.4, providerCost: 7644 })).toBe(true);
    expect(await credits(user.id)).toEqual({ balance: 10_000_000 - COST, held: 0 });
    expect(await ledger(user.id)).toEqual([
      { type: "HOLD", amount: COST, idempotencyKey: `tool-hold:${invocation.id}` },
      { type: "RELEASE", amount: -COST, idempotencyKey: `tool-release:${invocation.id}` },
      { type: "CHARGE", amount: -COST, idempotencyKey: `tool-charge:${invocation.id}` },
    ]);
    expect(await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).toMatchObject({ status: "COMPLETED", creditCost: COST, providerCost: 7644, durationMs: 31_500, output: { images: [{ url: "https://a.test/1.png" }] } });

    expect(await completeInvocation(invocation.id, { output: {}, durationMs: 1 })).toBe(false); // again: nothing changes
    expect(await credits(user.id)).toEqual({ balance: 10_000_000 - COST, held: 0 });
  });

  it("adds what the call made to the user's library, exactly once, in the same transaction", async () => {
    const { user, invocation } = await running();
    const assets = [
      { type: "image" as const, url: "https://a.test/1.png", prompt: "A fox", model: "GPT Image 2", width: 1024.4, height: 0, mimeType: "image/png" },
      { type: "image" as const, url: "javascript:alert(1)" }, // the database refuses it: skipped, the completion still goes through
      { type: "video" as const, url: "HTTPS://a.test/2.mp4", width: -5 },
    ];
    const results = await Promise.all(Array.from({ length: 3 }, () => completeInvocation(invocation.id, { output: { ok: 1 }, durationMs: 10, assets })));
    expect(results.filter(Boolean)).toHaveLength(1);
    const library = await prisma.mediaAsset.findMany({ orderBy: { url: "asc" }, select: { userId: true, source: true, type: true, url: true, prompt: true, model: true, width: true, height: true, toolInvocationId: true } });
    expect(library).toEqual([
      { userId: user.id, source: "GENERATED", type: "IMAGE", url: "https://a.test/1.png", prompt: "A fox", model: "GPT Image 2", width: 1024, height: null, toolInvocationId: invocation.id },
      { userId: user.id, source: "GENERATED", type: "VIDEO", url: "https://a.test/2.mp4", prompt: null, model: null, width: null, height: null, toolInvocationId: invocation.id },
    ]);
    expect((await ledger(user.id)).filter((e) => e.type === "CHARGE")).toHaveLength(1);
  });

  it("adds nothing for a call that was stopped before it completed", async () => {
    const { invocation } = await running();
    await endInvocation(invocation.id, "CANCELLED", "Stopped.");
    expect(await completeInvocation(invocation.id, { output: {}, durationMs: 1, assets: [{ type: "image", url: "https://a.test/late.png" }] })).toBe(false);
    expect(await prisma.mediaAsset.count()).toBe(0);
  });

  it("charges once when a completion is reported several times at once", async () => {
    const { user, invocation } = await running();
    const results = await Promise.all(Array.from({ length: 5 }, () => completeInvocation(invocation.id, { output: { ok: 1 }, durationMs: 10 })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await credits(user.id)).toEqual({ balance: 10_000_000 - COST, held: 0 });
    expect((await ledger(user.id)).filter((e) => e.type === "CHARGE")).toHaveLength(1);
  });

  it("releases a failed call's credits, once, and stores the safe reason", async () => {
    const { user, invocation } = await running();
    expect(await endInvocation(invocation.id, "FAILED", "Image generation timed out.")).toBe(true);
    expect(await endInvocation(invocation.id, "FAILED", "again")).toBe(false);
    expect(await credits(user.id)).toEqual({ balance: 10_000_000, held: 0 });
    expect(await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).toMatchObject({ status: "FAILED", errorMessage: "Image generation timed out.", creditCost: 0 });
    expect((await ledger(user.id)).map((e) => e.type)).toEqual(["HOLD", "RELEASE"]);
  });

  it("never charges a call that was stopped first, and never refunds one that completed first", async () => {
    const stopped = await running();
    await endInvocation(stopped.invocation.id, "CANCELLED", "Stopped.");
    expect(await completeInvocation(stopped.invocation.id, { output: {}, durationMs: 1 })).toBe(false);
    expect(await credits(stopped.user.id)).toEqual({ balance: 10_000_000, held: 0 });

    const done = await running();
    await completeInvocation(done.invocation.id, { output: {}, durationMs: 1 });
    expect(await endInvocation(done.invocation.id, "CANCELLED", "Stopped.")).toBe(false);
    expect(await credits(done.user.id)).toEqual({ balance: 10_000_000 - COST, held: 0 });
  });

  it("settles exactly once when a completion and a cancel race", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const { user, invocation } = await running();
      const [completed, cancelled] = await Promise.all([completeInvocation(invocation.id, { output: {}, durationMs: 1 }), endInvocation(invocation.id, "CANCELLED", "Stopped.")]);
      expect([completed, cancelled].filter(Boolean)).toHaveLength(1);
      const after = await credits(user.id);
      expect(after.held).toBe(0);
      expect(after.balance).toBe(completed ? 10_000_000 - COST : 10_000_000);
    }
  });

  it("can end a call that was never sent (PENDING), releasing its credits", async () => {
    const { user, run } = await aRun();
    const invocation = await createInvocation(call(run.id, user.id));
    expect(await endInvocation(invocation.id, "FAILED", "Invalid input.")).toBe(true);
    expect(await credits(user.id)).toEqual({ balance: 10_000_000, held: 0 });
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).durationMs).toBeNull();
  });

  it("totals what a turn's tool calls were charged", async () => {
    const { user, run } = await aRun();
    for (const [toolCallId, cost, outcome] of [["a", 1_000_000, "done"], ["b", 200_000, "done"], ["c", 500_000, "failed"]] as const) {
      const invocation = await createInvocation(call(run.id, user.id, toolCallId, cost));
      await markDispatching(invocation.id);
      if (outcome === "done") await completeInvocation(invocation.id, { output: {}, durationMs: 1 });
      else await endInvocation(invocation.id, "FAILED", "x");
    }
    expect(await turnToolCost(run.id)).toBe(1_200_000);
    expect(await credits(user.id)).toEqual({ balance: 10_000_000 - 1_200_000, held: 0 });
  });

});

describe("a run ending while its tool calls are still in progress", () => {
  async function runWithTools() {
    const user = await fixtures.user({ id: "u1", balance: 10_000_000 });
    const chat = await fixtures.chat(user.id);
    const turn = await activeTurn(chat.id, user.id, { status: "RUNNING", triggerRunId: "run_trig" }); // holds the 100,000 admission credits
    const pending = await createInvocation(call(turn.run.id, user.id, "pending"));
    const running = await createInvocation(call(turn.run.id, user.id, "running", 200_000));
    await markDispatching(running.id);
    await markRunning(running.id, "mg_1");
    const done = await createInvocation(call(turn.run.id, user.id, "done", 500_000));
    await markDispatching(done.id);
    await completeInvocation(done.id, { output: {}, durationMs: 1 });
    return { user, chat, turn, pending, running, done };
  }
  const statusOf = async (id: string) => (await prisma.toolInvocation.findUniqueOrThrow({ where: { id } })).status;

  it("ends them and releases their credits when the run is stopped, keeping what already completed", async () => {
    const { user, turn, pending, running, done } = await runWithTools();
    expect(await finalizeRun(turn.run.id, { status: "CANCELLED" })).toBe(true);
    expect(await prisma.toolInvocation.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({ status: "CANCELLED", errorMessage: "Stopped.", creditCost: 0 });
    expect(await statusOf(pending.id)).toBe("CANCELLED");
    expect(await statusOf(done.id)).toBe("COMPLETED");
    expect(await credits(user.id)).toEqual({ balance: 10_000_000 - 500_000, held: 0 }); // only the completed call is paid for
    expect(await completeInvocation(running.id, { output: {}, durationMs: 1 })).toBe(false); // a late finish charges nothing
    expect(await credits(user.id)).toEqual({ balance: 10_000_000 - 500_000, held: 0 });
  });

  it("explains why when the turn ended some other way", async () => {
    const { turn, running } = await runWithTools();
    await finalizeRun(turn.run.id, { status: "FAILED", errorCode: "AGENT_TIMEOUT", errorMessage: "The agent took too long." });
    expect(await prisma.toolInvocation.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({ status: "CANCELLED", errorMessage: "Stopped because the turn ended." });
  });

  it("releases everything when the chat is deleted mid-tool (nothing stays held)", async () => {
    const { user, chat } = await runWithTools();
    expect((await as("u1").delete(`/api/chats/${chat.id}`)).status).toBe(204);
    expect(await prisma.toolInvocation.count()).toBe(0);
    expect(await credits(user.id)).toEqual({ balance: 10_000_000 - 500_000, held: 0 });
  });

  it("changes nothing when the run had already ended", async () => {
    const { user, turn } = await runWithTools();
    await finalizeRun(turn.run.id, { status: "CANCELLED" });
    const before = await credits(user.id);
    expect(await finalizeRun(turn.run.id, { status: "CANCELLED" })).toBe(false);
    expect(await credits(user.id)).toEqual(before);
  });
});
