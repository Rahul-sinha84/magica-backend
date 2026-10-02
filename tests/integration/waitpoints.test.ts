import { pino } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ActiveRunResponseSchema, ContentBlocksSchema, ErrorResponseSchema, MessageListResponseSchema, RespondWaitpointResponseSchema, type AgentStreamChunk, type AgentStreamMetadata, type PlanPayload } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import type { AgentTurnPayload } from "#src/agent/payload.js";
import { runAgentTurn, type TurnDeps } from "#src/agent/runTurn.js";
import { TurnError } from "#src/agent/turnError.js";
import { MAX_RUN_MS, reconcileRun, WAITPOINT_SLACK_MS } from "#src/services/reconcile.js";
import { findActiveRun } from "#src/services/runs.js";
import { respondToWaitpoint } from "#src/services/waitpoints.js";
import { createToolRegistry, defineTool, ToolError } from "#src/tools/registry.js";
import { waitFor, type WaitContext } from "#src/waitpoints/wait.js";
import { anonymous, as } from "../helpers/app.js";
import { activeTurn, fixtures, resetDb } from "../helpers/db.js";
import { fakeModelSteps, finished, text, toolCall, type Script } from "../helpers/fakeModel.js";
import { fakeTokens } from "../helpers/fakeTokens.js";
import { trigger, triggerModule } from "../helpers/triggerMock.js";

async function until(condition: () => boolean, timeoutMs = 2_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const fake = fakeTokens();
beforeEach(async () => {
  await resetDb();
  fake.reset();
  trigger.onTokenCompleted = (id, output) => void fake.complete(id, output); // resetDb clears it
});

const PLAN: PlanPayload = { title: "A fox picture", overview: "Make a fox, then crop it.", steps: [{ title: "Generate the fox", tool: "gpt_image_2", estimatedCredits: 1_000_000 }], totalCredits: 1_000_000 };
const CREDIT = { calls: [{ toolCallId: "s1-a", toolName: "gpt_image_2", credits: 3_000_000 }], totalCredits: 3_000_000 };

// Test-only tools that ask the user (plan mode and spend approval arrive in later phases): they return the answer.
const Answer = z.object({ status: z.string(), feedback: z.string().optional() });
const askPlan = defineTool({
  name: "ask_plan",
  description: "Ask the user to approve a plan.",
  input: z.object({ title: z.string() }),
  output: Answer,
  kind: "inline",
  creditCost: 0,
  execute: async ({ title }, { waitFor: ask }) => {
    if (!ask) throw new ToolError("TOOL_FAILED", "This turn can't wait for an answer.");
    return ask("plan", { ...PLAN, title });
  },
});
const askCredit = defineTool({
  name: "ask_credit",
  description: "Ask the user to approve a spend.",
  input: z.object({}),
  output: Answer,
  kind: "inline",
  creditCost: 0,
  execute: async (_input, { waitFor: ask }) => {
    if (!ask) throw new ToolError("TOOL_FAILED", "This turn can't wait for an answer.");
    return ask("credit", CREDIT);
  },
});
const registry = createToolRegistry([askPlan, askCredit]);

async function setup(userId = "u1") {
  const user = await fixtures.user({ id: userId, balance: 10_000_000 });
  const chat = await fixtures.chat(user.id);
  const turn = await activeTurn(chat.id, user.id, { status: "PENDING", triggerRunId: null, ageMs: 1_000 });
  const payload: AgentTurnPayload = { agentRunId: turn.run.id, chatId: chat.id, userId: user.id, assistantMessageId: turn.assistantMessage.id, traceId: "trace_wp" };
  return { user, chat, turn, payload };
}

const ASK = [toolCall("ask_plan", { title: "Fox" }, "Ask1"), finished()];
const DONE = [text("Making it now."), finished()];

/** Starts a turn that asks, without waiting for it to finish. */
function start(payload: AgentTurnPayload, scripts: Script[] = [ASK, DONE], { waitpoints = true } = {}) {
  const model = fakeModelSteps(scripts);
  const emitted: AgentStreamChunk[] = [];
  const statuses: AgentStreamMetadata[] = [];
  const controller = new AbortController();
  const deps: TurnDeps = {
    stream: model.stream,
    emit: (chunk) => void emitted.push(chunk),
    setStatus: (status) => void statuses.push(status),
    triggerRunId: "run_trigger_wp",
    signal: controller.signal,
    flushEveryMs: 0,
    tools: { registry, skills: [], runMagicaCalls: () => Promise.resolve([]), ...(waitpoints && { waitpoints: fake.tokens }) },
  };
  return { done: runAgentTurn(payload, deps), model, emitted, statuses, controller };
}

const waitpointOf = (runId: string) => prisma.waitpoint.findFirstOrThrow({ where: { agentRunId: runId }, orderBy: { createdAt: "desc" } });
const respond = (userId: string, id: string, body: unknown) => as(userId).post(`/api/waitpoints/${id}/respond`).send(body as object);
const reply = async (id: string) => ContentBlocksSchema.parse((await prisma.message.findUniqueOrThrow({ where: { id } })).contentBlocks);
const toolResultOf = (model: ReturnType<typeof fakeModelSteps>, step: number) => JSON.parse((model.calls[step]?.messages.at(-1) as { content: string }).content) as unknown;

describe("a turn waiting for the user's answer", () => {
  it("waits, then resumes with the approval: the card is saved with how long it waited", async () => {
    const { turn, payload } = await setup();
    const { done, model, emitted, statuses } = start(payload);
    await fake.someoneWaiting();

    const pending = await waitpointOf(turn.run.id);
    expect(pending).toMatchObject({ type: "PLAN", status: "PENDING", resolvedAt: null, response: null, payload: { ...PLAN, title: "Fox" } });
    expect(pending.expiresAt.getTime() - pending.createdAt.getTime()).toBeGreaterThan(29 * 60_000);
    expect(fake.all()[0]).toMatchObject({ id: pending.triggerTokenId, key: `waitpoint:${turn.run.id}:plan:s1-Ask1`, tags: [`run_${turn.run.id}`], timeout: pending.expiresAt });
    expect(statuses.at(-1)).toEqual({ status: "waiting", waitpointId: pending.id });
    // saved before waiting, so a reload shows the card
    expect((await reply(turn.assistantMessage.id)).find((b) => b.type === "waitpoint")).toMatchObject({ waitpointId: pending.id, status: "pending", waitpointType: "plan" });

    const res = await respond("u1", pending.id, { action: "approve" });
    expect(res.status).toBe(200);
    expect(RespondWaitpointResponseSchema.parse(res.body).waitpoint).toMatchObject({ id: pending.id, runId: turn.run.id, type: "plan", status: "approved", feedback: null });
    expect(await done).toBe("completed");

    expect(toolResultOf(model, 1)).toEqual({ status: "approved" });
    expect(emitted.filter((c) => c.type.startsWith("waitpoint"))).toEqual([
      { type: "waitpoint-start", waitpointId: pending.id, waitpointType: "plan", payload: { ...PLAN, title: "Fox" }, expiresAt: pending.expiresAt.toISOString() },
      { type: "waitpoint-end", waitpointId: pending.id, status: "approved", waitedMs: expect.any(Number) as unknown },
    ]);
    expect(statuses.map((s) => s.status)).toEqual(expect.arrayContaining(["waiting", "working", "complete"]));
    const blocks = await reply(turn.assistantMessage.id);
    expect(blocks.map((b) => b.type)).toEqual(["tool_call", "tool_result", "waitpoint", "text", "usage"]);
    expect(blocks[2]).toMatchObject({ type: "waitpoint", status: "approved", waitedMs: expect.any(Number) as unknown });
    expect(await prisma.waitpoint.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: "APPROVED", response: { action: "approve" }, resolvedAt: expect.any(Date) as unknown });
  });

  it("hands Request Changes and its feedback back to the agent, and shows the feedback on the card", async () => {
    const { turn, payload } = await setup();
    const { done, model } = start(payload);
    await fake.someoneWaiting();
    const { id } = await waitpointOf(turn.run.id);
    const res = await respond("u1", id, { action: "request_changes", feedback: "  Make it a red fox  " });
    expect(res.body).toMatchObject({ waitpoint: { status: "changes_requested", feedback: "Make it a red fox" } });
    expect(await done).toBe("completed");
    expect(toolResultOf(model, 1)).toEqual({ status: "changes_requested", feedback: "Make it a red fox" });
    expect((await reply(turn.assistantMessage.id)).find((b) => b.type === "waitpoint")).toMatchObject({ status: "changes_requested", feedback: "Make it a red fox" });
  });

  it("answers a spend approval with approve or reject", async () => {
    const { turn, payload } = await setup();
    const { done, model } = start(payload, [[toolCall("ask_credit", {}, "Spend1"), finished()], DONE]);
    await fake.someoneWaiting();
    const { id, type } = await waitpointOf(turn.run.id);
    expect(type).toBe("CREDIT");
    expect((await respond("u1", id, { action: "reject" })).body).toMatchObject({ waitpoint: { type: "credit", status: "rejected", payload: CREDIT } });
    expect(await done).toBe("completed");
    expect(toolResultOf(model, 1)).toEqual({ status: "rejected" });
  });

  it("is shown again on reload: the active run carries the pending waitpoint, and the card in its partial reply", async () => {
    const { chat, turn, payload } = await setup();
    const { done } = start(payload);
    await fake.someoneWaiting();
    const { id } = await waitpointOf(turn.run.id);

    const body = ActiveRunResponseSchema.parse((await as("u1").get(`/api/chats/${chat.id}/active-run`)).body);
    expect(body.pendingWaitpoint).toMatchObject({ id, runId: turn.run.id, type: "plan", status: "pending", payload: { ...PLAN, title: "Fox" }, feedback: null, resolvedAt: null });
    expect(body.partialBlocks.find((b) => b.type === "waitpoint")).toMatchObject({ waitpointId: id, status: "pending" });

    await respond("u1", id, { action: "approve" });
    await done;
    expect((await as("u1").get(`/api/chats/${chat.id}/active-run`)).body).toMatchObject({ run: null, pendingWaitpoint: null });
  });

  it("expires: the turn fails with WAITPOINT_EXPIRED (retryable), the card says so, and the credit hold is released", async () => {
    const { chat, turn, payload } = await setup();
    const { done, statuses } = start(payload);
    await fake.someoneWaiting();
    const waitpoint = await waitpointOf(turn.run.id);
    fake.timeOut(waitpoint.triggerTokenId);

    expect(await done).toBe("failed");
    expect(statuses.at(-1)).toEqual({ status: "failed", error: "This approval expired. Send a new message to continue." });
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: turn.run.id } })).toMatchObject({ status: "FAILED", errorCode: "WAITPOINT_EXPIRED" });
    expect(await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } })).toMatchObject({ status: "EXPIRED", response: null, resolvedAt: expect.any(Date) as unknown });
    expect((await reply(turn.assistantMessage.id)).find((b) => b.type === "waitpoint")).toMatchObject({ status: "expired", waitedMs: expect.any(Number) as unknown });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: "u1" }, select: { held: true } })).toEqual({ held: 0 });

    const { messages } = MessageListResponseSchema.parse((await as("u1").get(`/api/chats/${chat.id}/messages`)).body);
    expect(messages.at(-1)).toMatchObject({ status: "FAILED", errorMessage: "This approval expired. Send a new message to continue.", canRetry: true });
    // too late to answer now: it stands as expired
    expect((await respond("u1", waitpoint.id, { action: "approve" })).body).toMatchObject({ waitpoint: { status: "expired" } });
    expect(trigger.completedTokens).toEqual([]);
  });

  it("stops cleanly while waiting: run, reply, card and waitpoint all end as cancelled, and a late answer changes nothing", async () => {
    const { turn, payload } = await setup();
    const { done, controller, statuses } = start(payload);
    await fake.someoneWaiting();
    const waitpoint = await waitpointOf(turn.run.id);

    expect((await as("u1").post(`/api/runs/${turn.run.id}/cancel`)).status).toBe(204);
    expect(trigger.cancelled).toEqual(["run_trigger_wp"]);
    controller.abort(); // what Trigger.dev's cancel does to the task
    expect(await done).toBe("cancelled");
    expect(statuses.at(-1)).toEqual({ status: "cancelled" });

    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: turn.run.id } })).toMatchObject({ status: "CANCELLED" });
    expect(await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } })).toMatchObject({ status: "CANCELLED", resolvedAt: expect.any(Date) as unknown });
    const message = await prisma.message.findUniqueOrThrow({ where: { id: turn.assistantMessage.id } });
    expect(message.status).toBe("CANCELLED");
    expect(ContentBlocksSchema.parse(message.contentBlocks).find((b) => b.type === "waitpoint")).toMatchObject({ status: "cancelled" });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: "u1" }, select: { held: true } })).toEqual({ held: 0 });

    expect((await respond("u1", waitpoint.id, { action: "approve" })).body).toMatchObject({ waitpoint: { status: "cancelled" } });
    expect(trigger.completedTokens).toEqual([]);
  });

  it("ends quietly if it wakes to find it was stopped (Trigger.dev's cancel never reached it)", async () => {
    const { turn, payload } = await setup();
    const { done } = start(payload);
    await fake.someoneWaiting();
    const waitpoint = await waitpointOf(turn.run.id);
    await as("u1").post(`/api/runs/${turn.run.id}/cancel`);
    fake.timeOut(waitpoint.triggerTokenId); // no abort: it sleeps until the token times out
    expect(await done).toBe("cancelled");
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: turn.run.id } })).toMatchObject({ status: "CANCELLED", errorCode: null });
  });

  it("ends quietly if its chat is deleted while it waits (the waitpoint goes with it)", async () => {
    const { chat, turn, payload } = await setup();
    const { done } = start(payload);
    await fake.someoneWaiting();
    const { triggerTokenId } = await waitpointOf(turn.run.id);
    expect((await as("u1").delete(`/api/chats/${chat.id}`)).status).toBe(204);
    expect(await prisma.waitpoint.count()).toBe(0);
    fake.timeOut(triggerTokenId);
    expect(await done).toBe("cancelled");
  });

  it("asks one question at a time: a second waitpoint in the same step waits for the first to be answered", async () => {
    const { turn, payload } = await setup();
    const { done, model } = start(payload, [[toolCall("ask_plan", { title: "One" }, "AskA"), toolCall("ask_credit", {}, "AskB"), finished()], DONE]);
    await fake.someoneWaiting();
    expect(await prisma.waitpoint.count()).toBe(1);
    const first = await waitpointOf(turn.run.id);
    await respond("u1", first.id, { action: "approve" });

    await fake.someoneWaiting();
    const second = await waitpointOf(turn.run.id);
    expect(second.id).not.toBe(first.id);
    expect(second.type).toBe("CREDIT");
    await respond("u1", second.id, { action: "approve" });
    expect(await done).toBe("completed");
    expect(await prisma.waitpoint.findMany({ orderBy: { createdAt: "asc" }, select: { status: true } })).toEqual([{ status: "APPROVED" }, { status: "APPROVED" }]);
    expect(model.calls[1]?.messages.slice(-2).map((m) => JSON.parse((m as { content: string }).content) as unknown)).toEqual([{ status: "approved" }, { status: "approved" }]);
  });

  it("can't wait where waitpoints aren't available: the tool says so and the turn goes on", async () => {
    const { payload } = await setup();
    const { done, model } = start(payload, [ASK, DONE], { waitpoints: false });
    expect(await done).toBe("completed");
    expect(toolResultOf(model, 1)).toEqual({ error: "This turn can't wait for an answer." });
    expect(await prisma.waitpoint.count()).toBe(0);
  });
});

describe("waking and the database disagreeing", () => {
  it("goes with the saved answer when the run wakes on its timeout just after the answer was saved", async () => {
    const { turn, payload } = await setup();
    const { done, model } = start(payload);
    await fake.someoneWaiting();
    const waitpoint = await waitpointOf(turn.run.id);
    trigger.onTokenCompleted = null; // the answer is saved, but the wake-up never reaches the run
    expect((await respond("u1", waitpoint.id, { action: "approve" })).body).toMatchObject({ waitpoint: { status: "approved" } });
    fake.timeOut(waitpoint.triggerTokenId);
    expect(await done).toBe("completed");
    expect(toolResultOf(model, 1)).toEqual({ status: "approved" });
  });

  it("saves the answer itself when the token was answered but the row never was", async () => {
    const { turn, payload } = await setup();
    const { done, model } = start(payload);
    await fake.someoneWaiting();
    const waitpoint = await waitpointOf(turn.run.id);
    fake.complete(waitpoint.triggerTokenId, { action: "request_changes", feedback: "Smaller" });
    expect(await done).toBe("completed");
    expect(toolResultOf(model, 1)).toEqual({ status: "changes_requested", feedback: "Smaller" });
    expect(await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } })).toMatchObject({ status: "CHANGES_REQUESTED", response: { action: "request_changes", feedback: "Smaller" } });
  });

  it("treats a token completed with something that isn't a valid answer as expired", async () => {
    const { turn, payload } = await setup();
    const { done } = start(payload);
    await fake.someoneWaiting();
    const waitpoint = await waitpointOf(turn.run.id);
    fake.complete(waitpoint.triggerTokenId, { action: "reject" }); // a plan can't be rejected
    expect(await done).toBe("failed");
    expect(await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } })).toMatchObject({ status: "EXPIRED" });
  });

  it("cancels a pending waitpoint left by an earlier attempt before asking again", async () => {
    const { turn, payload } = await setup();
    const stale = await prisma.waitpoint.create({ data: { agentRunId: turn.run.id, type: "PLAN", triggerTokenId: "waitpoint_old", payload: PLAN, expiresAt: new Date(Date.now() + 60_000) } });
    const { done } = start(payload);
    await fake.someoneWaiting();
    expect(await prisma.waitpoint.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ status: "CANCELLED" });
    const current = await waitpointOf(turn.run.id);
    expect(current).toMatchObject({ status: "PENDING" });
    await respond("u1", current.id, { action: "approve" });
    expect(await done).toBe("completed");
  });
});

describe("POST /api/waitpoints/:id/respond", () => {
  async function waiting() {
    const context = await setup();
    const turn = start(context.payload);
    await fake.someoneWaiting();
    return { ...context, ...turn, waitpoint: await waitpointOf(context.turn.run.id) };
  }

  it("wakes the run once however often it is answered, at the same moment or later: 200 each time, as it stands", async () => {
    const { waitpoint, done } = await waiting();
    const [a, b] = await Promise.all([respond("u1", waitpoint.id, { action: "approve" }), respond("u1", waitpoint.id, { action: "approve" })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body, b.body]).toMatchObject([{ waitpoint: { status: "approved" } }, { waitpoint: { status: "approved" } }]);
    const later = await respond("u1", waitpoint.id, { action: "request_changes", feedback: "Too late" });
    expect(later.body).toMatchObject({ waitpoint: { status: "approved", feedback: null } }); // the first answer stands
    expect(trigger.completedTokens).toEqual([{ tokenId: waitpoint.triggerTokenId, output: { action: "approve" } }]);
    expect(await done).toBe("completed");
  });

  it("lets an answer racing another one in flight wait for it, then see it (one wake-up, not two)", async () => {
    const { waitpoint, done } = await waiting();
    const before = vi.mocked(triggerModule.completeWaitpointToken).mock.calls.length;
    const wakeUps = () => vi.mocked(triggerModule.completeWaitpointToken).mock.calls.length - before;
    let open = () => undefined as void;
    trigger.completeTokenGate = new Promise<void>((resolve) => (open = resolve));
    const first = respond("u1", waitpoint.id, { action: "approve" }).then((res) => res);
    await until(() => wakeUps() === 1); // the first holds the lock, waking the run
    const second = respond("u1", waitpoint.id, { action: "request_changes", feedback: "No" }).then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 200)); // the second is now waiting on the first's lock
    expect(wakeUps()).toBe(1);
    open();
    const [a, b] = await Promise.all([first, second]);
    expect([a.body, b.body]).toMatchObject([{ waitpoint: { status: "approved" } }, { waitpoint: { status: "approved" } }]);
    expect(trigger.completedTokens).toHaveLength(1);
    expect(await done).toBe("completed");
  });

  it("is the owner's alone: anyone else gets a 404 and nothing changes", async () => {
    const { waitpoint, done, controller } = await waiting();
    await fixtures.user({ id: "u2" });
    const res = await respond("u2", waitpoint.id, { action: "approve" });
    expect(res.status).toBe(404);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({ code: "NOT_FOUND", error: "That approval isn't there any more." });
    expect(await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } })).toMatchObject({ status: "PENDING" });
    expect(trigger.completedTokens).toEqual([]);
    controller.abort();
    await done;
  });

  it("saves nothing when the run can't be woken (503), so answering again works", async () => {
    const { waitpoint, done } = await waiting();
    trigger.completeTokenError = new Error("Trigger.dev is down");
    const res = await respond("u1", waitpoint.id, { action: "approve" });
    expect(res.status).toBe(503);
    expect(ErrorResponseSchema.parse(res.body)).toMatchObject({ code: "SERVICE_UNAVAILABLE", error: "We couldn't send your answer right now. Try again in a moment." });
    expect(await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } })).toMatchObject({ status: "PENDING", response: null, resolvedAt: null });

    trigger.completeTokenError = null;
    expect((await respond("u1", waitpoint.id, { action: "approve" })).body).toMatchObject({ waitpoint: { status: "approved" } });
    expect(await done).toBe("completed");
  });

  it("calls it expired when answered after its expiry, without waking the run (it wakes on its own timeout)", async () => {
    const { waitpoint, done } = await waiting();
    const late = new Date(waitpoint.expiresAt.getTime() + 1);
    const answered = await respondToWaitpoint("u1", waitpoint.id, { action: "approve" }, { completeToken: () => Promise.reject(new Error("never called")), now: late });
    expect(answered).toMatchObject({ status: "expired", resolvedAt: late.toISOString() });
    fake.timeOut(waitpoint.triggerTokenId);
    expect(await done).toBe("failed");
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: waitpoint.agentRunId } })).toMatchObject({ errorCode: "WAITPOINT_EXPIRED" });
  });

  it.each([
    ["an answer this kind doesn't take", { action: "reject" }, "action: A plan can be answered with approve or request_changes."],
    ["Request Changes without feedback", { action: "request_changes" }, "feedback: Say what you'd like changed."],
    ["blank feedback", { action: "request_changes", feedback: "   " }, undefined],
    ["feedback that is too long", { action: "request_changes", feedback: "x".repeat(2001) }, undefined],
    ["an unknown action", { action: "maybe" }, undefined],
    ["an unknown field", { action: "approve", extra: 1 }, undefined],
    ["no body", undefined, undefined],
  ])("refuses %s with a 400, changing nothing", async (_label, body, message) => {
    const { waitpoint, controller, done } = await waiting();
    const res = await respond("u1", waitpoint.id, body);
    expect(res.status).toBe(400);
    const error = ErrorResponseSchema.parse(res.body);
    expect(error.code).toBe("VALIDATION_FAILED");
    if (message) expect(error.error).toBe(message);
    expect(await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } })).toMatchObject({ status: "PENDING" });
    controller.abort();
    await done;
  });

  it("answers 404 for an id that doesn't exist or isn't an id, and 401 without a session", async () => {
    await fixtures.user({ id: "u1" });
    expect((await respond("u1", "cmnotawaitpoint000000000", { action: "approve" })).status).toBe(404);
    expect((await respond("u1", "not an id!", { action: "approve" })).status).toBe(404);
    expect((await anonymous().post("/api/waitpoints/abc/respond").send({ action: "approve" })).status).toBe(401);
  });
});

describe("waitFor", () => {
  function context(runId: string, lines: Record<string, unknown>[] = []): WaitContext & { emitted: AgentStreamChunk[] } {
    const emitted: AgentStreamChunk[] = [];
    const log = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) });
    return { runId, tokens: fake.tokens, emit: (chunk) => void emitted.push(chunk), checkpoint: () => Promise.resolve(true), setStatus: () => undefined, now: Date.now, log, signal: new AbortController().signal, emitted };
  }
  async function running() {
    const { turn } = await setup();
    await prisma.agentRun.update({ where: { id: turn.run.id }, data: { status: "RUNNING" } });
    return turn.run.id;
  }

  it("gives the same waitpoint, and its answer, when the same asking comes again", async () => {
    const runId = await running();
    const ctx = context(runId);
    const first = waitFor(ctx, "plan", PLAN, "s1-x");
    await fake.someoneWaiting();
    const { id } = await waitpointOf(runId);
    await respond("u1", id, { action: "approve" });
    expect(await first).toEqual({ status: "approved" });
    expect(await waitFor(ctx, "plan", PLAN, "s1-x")).toEqual({ status: "approved" });
    expect(await prisma.waitpoint.count()).toBe(1);
    expect(fake.all()).toHaveLength(1);
  });

  it("writes logs that carry the waitpoint's id", async () => {
    const runId = await running();
    const lines: Record<string, unknown>[] = [];
    const answer = waitFor(context(runId, lines), "plan", PLAN, "s1-y");
    await fake.someoneWaiting();
    const { id } = await waitpointOf(runId);
    await respond("u1", id, { action: "approve" });
    await answer;
    expect(lines.map((line) => [line.msg, line.waitpointId])).toEqual([
      ["waiting for the user's answer", id],
      ["waitpoint over", id],
    ]);
  });

  it("doesn't wait for a run that has already ended, and writes nothing", async () => {
    const { turn } = await setup();
    await prisma.agentRun.update({ where: { id: turn.run.id }, data: { status: "CANCELLED" } });
    await expect(waitFor(context(turn.run.id), "plan", PLAN, "s1-z")).rejects.toEqual(new TurnError("RUN_ENDED", "The run was stopped."));
    expect(await prisma.waitpoint.count()).toBe(0);
  });

  it("refuses a payload that doesn't fit its kind before asking anything", async () => {
    const runId = await running();
    await expect(waitFor(context(runId), "credit", PLAN, "s1-w")).rejects.toThrow();
    expect(fake.all()).toEqual([]);
  });
});

describe("the stale-run rule and waiting runs", () => {
  async function longRun({ startedMinutesAgo, waitpoint }: { startedMinutesAgo: number; waitpoint?: { status: "PENDING" | "APPROVED"; expiresInMs?: number; resolvedMinutesAgo?: number } }) {
    const user = await fixtures.user({ id: "u1" });
    const chat = await fixtures.chat(user.id);
    const startedAt = new Date(Date.now() - startedMinutesAgo * 60_000);
    const { run } = await activeTurn(chat.id, user.id, { ageMs: startedMinutesAgo * 60_000 + 1_000, startedAt, quietMs: 1_000 });
    if (waitpoint) {
      const resolvedAt = waitpoint.resolvedMinutesAgo === undefined ? null : new Date(Date.now() - waitpoint.resolvedMinutesAgo * 60_000);
      await prisma.waitpoint.create({
        data: {
          agentRunId: run.id,
          type: "PLAN",
          status: waitpoint.status,
          triggerTokenId: `waitpoint_${run.id}`,
          payload: PLAN,
          createdAt: new Date(Date.now() - 60 * 60_000),
          expiresAt: new Date(Date.now() + (waitpoint.expiresInMs ?? 60_000)),
          resolvedAt,
          ...(waitpoint.status === "APPROVED" && { response: { action: "approve" } }),
        },
      });
    }
    return { chat, run: (await findActiveRun(chat.id))! };
  }

  it("leaves a run alone while it waits for an answer, however long it has been going", async () => {
    const { run } = await longRun({ startedMinutesAgo: 25, waitpoint: { status: "PENDING", expiresInMs: 5 * 60_000 } });
    expect(await reconcileRun(run)).toBe(false);
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "RUNNING" });
  });

  it("still allows the slack just after the waitpoint expired, for the run to end itself", async () => {
    const { run } = await longRun({ startedMinutesAgo: 40, waitpoint: { status: "PENDING", expiresInMs: -(WAITPOINT_SLACK_MS - 10_000) } });
    expect(await reconcileRun(run)).toBe(false);
  });

  it("ends a run whose waitpoint expired past the slack as WAITPOINT_EXPIRED, closing the waitpoint as expired", async () => {
    const { run } = await longRun({ startedMinutesAgo: 40, waitpoint: { status: "PENDING", expiresInMs: -(WAITPOINT_SLACK_MS + 10_000) } });
    expect(await reconcileRun(run)).toBe(true);
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "FAILED", errorCode: "WAITPOINT_EXPIRED", errorMessage: "This approval expired. Send a new message to continue." });
    expect(await prisma.waitpoint.findFirstOrThrow({ where: { agentRunId: run.id } })).toMatchObject({ status: "EXPIRED" });
  });

  it("counts the time limit again from when the run resumed after an answer", async () => {
    const resumed = await longRun({ startedMinutesAgo: 30, waitpoint: { status: "APPROVED", resolvedMinutesAgo: 5 } });
    expect(await reconcileRun(resumed.run)).toBe(false);
    await resetDb();
    const overdue = await longRun({ startedMinutesAgo: 30, waitpoint: { status: "APPROVED", resolvedMinutesAgo: MAX_RUN_MS / 60_000 + 1 } });
    expect(await reconcileRun(overdue.run)).toBe(true);
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: overdue.run.id } })).toMatchObject({ status: "FAILED", errorCode: "AGENT_TIMEOUT" });
  });

  it("still ends a run that never waited once it is past the limit", async () => {
    const { run } = await longRun({ startedMinutesAgo: MAX_RUN_MS / 60_000 + 1 });
    expect(await reconcileRun(run)).toBe(true);
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ errorCode: "AGENT_TIMEOUT" });
  });
});

describe("the Waitpoint table", () => {
  async function aRun() {
    const { turn } = await setup();
    return turn.run.id;
  }
  const row = (agentRunId: string, overrides: Record<string, unknown> = {}) => ({ agentRunId, type: "PLAN" as const, triggerTokenId: `t_${Math.random()}`, payload: PLAN, expiresAt: new Date(Date.now() + 60_000), ...overrides });

  it("holds one pending waitpoint per run, any number closed", async () => {
    const runId = await aRun();
    await prisma.waitpoint.create({ data: row(runId) });
    await expect(prisma.waitpoint.create({ data: row(runId) })).rejects.toThrow();
    await prisma.waitpoint.create({ data: row(runId, { status: "CANCELLED", resolvedAt: new Date() }) });
    await prisma.waitpoint.create({ data: row(runId, { status: "EXPIRED", resolvedAt: new Date() }) });
    expect(await prisma.waitpoint.count()).toBe(3);
  });

  it.each([
    ["closed without a resolved time", { status: "CANCELLED" }],
    ["pending with a resolved time", { resolvedAt: new Date() }],
    ["answered without the answer", { status: "APPROVED", resolvedAt: new Date() }],
    ["an answer on one that was never answered", { status: "EXPIRED", resolvedAt: new Date(), response: { action: "approve" } }],
    ["expiring before it was created", { createdAt: new Date(), expiresAt: new Date(Date.now() - 1) }],
  ])("refuses a row %s", async (_label, overrides) => {
    const runId = await aRun();
    await expect(prisma.waitpoint.create({ data: row(runId, overrides) })).rejects.toThrow();
  });

  it("goes with its run", async () => {
    const runId = await aRun();
    await prisma.waitpoint.create({ data: row(runId) });
    await prisma.agentRun.delete({ where: { id: runId } });
    expect(await prisma.waitpoint.count()).toBe(0);
  });
});
