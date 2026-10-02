import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContentBlocksSchema, type AgentStreamChunk } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { loadConversation } from "#src/agent/context.js";
import type { AgentTurnPayload } from "#src/agent/payload.js";
import { runAgentTurn, type TurnDeps } from "#src/agent/runTurn.js";
import { SPEND_DECLINED, SPEND_DECLINED_FOR_MODEL } from "#src/agent/toolStep.js";
import { TOOL_CREDIT_COSTS } from "#src/tools/costs.js";
import { agentTools } from "#src/tools/index.js";
import { runMagicaInvocation } from "#src/tools/magicaInvocation.js";
import { as } from "../helpers/app.js";
import { activeTurn, fixtures, resetDb } from "../helpers/db.js";
import { fakeModelSteps, finished, text, toolCall, type Script } from "../helpers/fakeModel.js";
import { fakeTokens } from "../helpers/fakeTokens.js";
import { fakeClockClient, fixture, startMagicaServer, type Reply } from "../helpers/magicaServer.js";
import { trigger } from "../helpers/triggerMock.js";

const fake = fakeTokens();
const servers: { close: () => Promise<void> }[] = [];
beforeEach(async () => {
  await resetDb();
  fake.reset();
  trigger.onTokenCompleted = (id, output) => void fake.complete(id, output);
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const silent = pino({ level: "silent" });
const IMAGE = TOOL_CREDIT_COSTS.gpt_image_2;

async function magica() {
  const server = await startMagicaServer({
    "POST /v1/nodes/*/run": [{ status: 202, json: { runId: "mg_1" } }],
    "GET /v1/nodes/runs/*": [{ status: 200, json: fixture("run.gpt_text.completed.json") }] as Reply[],
    "GET /v1/models/gpt-image-2-text/schema": [{ status: 200, json: fixture("schema.gpt-image-2-text.json") }],
  });
  servers.push(server);
  return server;
}

const image = (id: string, prompt = "A fox") => toolCall("gpt_image_2", { mode: "text", prompt, quality: "low" }, id);
const twoImages = (a = "ImgCallA", b = "ImgCallB") => [image(a, "A fox"), image(b, "A wolf"), finished()];
const DONE = [text("Done."), finished()];

async function setup({ balance = 10_000_000, mode = "DEFAULT" }: { balance?: number; mode?: "DEFAULT" | "PLAN" } = {}) {
  const user = await fixtures.user({ id: "u1", balance });
  const chat = await fixtures.chat(user.id);
  const turn = await activeTurn(chat.id, user.id, { status: "PENDING", triggerRunId: null, ageMs: 1_000, heldCredits: 0 });
  await prisma.agentRun.update({ where: { id: turn.run.id }, data: { mode } });
  await prisma.message.update({ where: { id: turn.run.triggerMessageId }, data: { content: "Make a fox and a wolf" } });
  const payload: AgentTurnPayload = { agentRunId: turn.run.id, chatId: chat.id, userId: user.id, assistantMessageId: turn.assistantMessage.id, traceId: "trace_spend" };
  return { chat, turn, payload };
}

async function start(payload: AgentTurnPayload, scripts: Script[], threshold: number | undefined) {
  const server = await magica();
  const model = fakeModelSteps(scripts);
  const emitted: AgentStreamChunk[] = [];
  const controller = new AbortController();
  const clock = fakeClockClient(server.url);
  const deps: TurnDeps = {
    stream: model.stream,
    emit: (chunk) => void emitted.push(chunk),
    setStatus: () => undefined,
    triggerRunId: "run_trigger_spend",
    signal: controller.signal,
    flushEveryMs: 0,
    tools: {
      registry: agentTools,
      skills: [],
      waitpoints: fake.tokens,
      ...(threshold !== undefined && { creditApprovalThreshold: threshold }),
      runMagicaCalls: (calls) => Promise.all(calls.map((call) => runMagicaInvocation(call.invocationId, { client: clock.client, now: clock.now, registry: agentTools, log: silent, signal: controller.signal }))),
    },
  };
  return { done: runAgentTurn(payload, deps), model, emitted, server };
}

const pending = async () => {
  await fake.someoneWaiting();
  return prisma.waitpoint.findFirstOrThrow({ where: { status: "PENDING" } });
};
const answer = (id: string, action: string) => as("u1").post(`/api/waitpoints/${id}/respond`).send({ action });
const balance = async () => prisma.user.findUniqueOrThrow({ where: { id: "u1" }, select: { balance: true, held: true } });
const invocations = () => prisma.toolInvocation.findMany({ orderBy: { createdAt: "asc" }, select: { status: true, creditCost: true } });
const toolResults = (model: ReturnType<typeof fakeModelSteps>, step: number) =>
  (model.calls[step]?.messages ?? []).filter((m) => m.role === "tool").map((m) => JSON.parse((m as { content: string }).content) as Record<string, unknown>);

describe("spend approval", () => {
  it("doesn't ask below the threshold: a single image runs at the default", async () => {
    const { payload } = await setup();
    const { done } = await start(payload, [[image("ImgCall1"), finished()], DONE], 2_000_000);
    expect(await done).toBe("completed");
    expect(await prisma.waitpoint.count()).toBe(0);
    expect(await invocations()).toEqual([{ status: "COMPLETED", creditCost: IMAGE }]);
  });

  it("doesn't ask at exactly the threshold (only above it)", async () => {
    const { payload } = await setup();
    const { done } = await start(payload, [[image("ImgCall1"), finished()], DONE], IMAGE);
    expect(await done).toBe("completed");
    expect(await prisma.waitpoint.count()).toBe(0);
  });

  it("asks above it, adding up the step's calls, and runs and charges each once when approved", async () => {
    const { turn, payload } = await setup();
    const { done, server } = await start(payload, [twoImages(), DONE], 1_500_000);
    const waiting = await pending();
    expect(waiting).toMatchObject({
      type: "CREDIT",
      payload: {
        calls: [
          { toolCallId: "s1-ImgCallA", toolName: "gpt_image_2", credits: IMAGE },
          { toolCallId: "s1-ImgCallB", toolName: "gpt_image_2", credits: IMAGE },
        ],
        totalCredits: 2 * IMAGE,
      },
    });
    expect(server.count("POST")).toBe(0); // nothing sent to Magica while it waits
    expect(await invocations()).toEqual([]); // nor any credits reserved

    expect((await answer(waiting.id, "approve")).body).toMatchObject({ waitpoint: { type: "credit", status: "approved" } });
    expect(await done).toBe("completed");
    expect(await invocations()).toEqual([
      { status: "COMPLETED", creditCost: IMAGE },
      { status: "COMPLETED", creditCost: IMAGE },
    ]);
    expect(await balance()).toEqual({ balance: 10_000_000 - 2 * IMAGE, held: 0 });
    expect((await prisma.creditLedger.findMany({ where: { type: "CHARGE" } })).map((e) => e.amount)).toEqual([-IMAGE, -IMAGE]);
    const card = ContentBlocksSchema.parse((await prisma.message.findUniqueOrThrow({ where: { id: turn.assistantMessage.id } })).contentBlocks).find((b) => b.type === "waitpoint");
    expect(card).toMatchObject({ waitpointType: "credit", status: "approved" });
  });

  it("fails those calls when declined, charging nothing, and the agent carries on", async () => {
    const { chat, turn, payload } = await setup();
    const { done, model, emitted, server } = await start(payload, [twoImages(), [text("Okay, I won't make them."), finished()]], 1_500_000);
    await answer((await pending()).id, "reject");
    expect(await done).toBe("completed");

    // the card tells the user they declined; the model is told the user did, and not to try again on its own
    expect(toolResults(model, 1)).toEqual([{ error: SPEND_DECLINED_FOR_MODEL }, { error: SPEND_DECLINED_FOR_MODEL }]);
    expect(SPEND_DECLINED).toBe("You declined this spend.");
    expect(SPEND_DECLINED_FOR_MODEL).toMatch(/^The user declined this spend.*Don't try it again unless the user asks/);
    expect(emitted.filter((c) => c.type === "tool-end").map((c) => c.type === "tool-end" && [c.status, c.errorMessage])).toEqual([
      ["failed", SPEND_DECLINED],
      ["failed", SPEND_DECLINED],
    ]);
    expect(server.count("POST")).toBe(0);
    expect(await invocations()).toEqual([]);
    expect(await balance()).toEqual({ balance: 10_000_000, held: 0 });
    expect((await prisma.message.findUniqueOrThrow({ where: { id: turn.assistantMessage.id } })).content).toBe("Okay, I won't make them.");
    // and a later turn knows the spend was declined
    const later = await activeTurn(chat.id, "u1", { status: "PENDING", triggerRunId: null, heldCredits: 0, ageMs: 0 }); // asked after the first
    const history = await loadConversation(chat.id, later.run.triggerMessageId);
    expect(history.find((m) => m.role === "assistant")?.content).toContain(`[Spend of ${2 * IMAGE} credits declined]`);
  });

  it("asks again when the agent tries again after a decline in the same turn", async () => {
    const { payload } = await setup();
    const { done } = await start(payload, [twoImages(), twoImages("ImgCallC", "ImgCallD"), DONE], 1_500_000);
    await answer((await pending()).id, "reject");
    const second = await pending();
    expect(second.payload).toMatchObject({ calls: [{ toolCallId: "s2-ImgCallC" }, { toolCallId: "s2-ImgCallD" }] });
    await answer(second.id, "approve");
    expect(await done).toBe("completed");
    expect(await prisma.waitpoint.findMany({ orderBy: { createdAt: "asc" }, select: { status: true } })).toEqual([{ status: "REJECTED" }, { status: "APPROVED" }]);
    expect(await invocations()).toHaveLength(2);
  });

  it("doesn't ask again once a plan is approved: the plan covers the turn's spend", async () => {
    const { payload } = await setup({ mode: "PLAN" });
    const plan = { title: "Two animals", overview: "A fox and a wolf.", steps: [{ title: "Fox", tool: "gpt_image_2" }, { title: "Wolf", tool: "gpt_image_2" }] };
    const { done } = await start(payload, [[toolCall("propose_plan", plan, "PlanCall1"), finished()], twoImages(), DONE], 1_500_000);
    const waiting = await pending();
    expect(waiting.type).toBe("PLAN");
    await answer(waiting.id, "approve");
    expect(await done).toBe("completed");
    expect(await prisma.waitpoint.count({ where: { type: "CREDIT" } })).toBe(0);
    expect(await invocations()).toHaveLength(2);
  });

  it("stops cleanly if the credits run out after the approval, charging nothing", async () => {
    const { turn, payload } = await setup({ balance: 1_500_000 });
    const { done, server } = await start(payload, [twoImages(), DONE], 1_000_000);
    await answer((await pending()).id, "approve");
    expect(await done).toBe("failed");
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: turn.run.id } })).toMatchObject({ errorCode: "INSUFFICIENT_CREDITS" });
    expect(server.count("POST")).toBe(0);
    expect(await balance()).toEqual({ balance: 1_500_000, held: 0 });
  });

  it("fails the turn as expired if nobody answers, closing the waiting tool cards and charging nothing", async () => {
    const { turn, payload } = await setup();
    const { done } = await start(payload, [twoImages(), DONE], 1_500_000);
    fake.timeOut((await pending()).triggerTokenId);
    expect(await done).toBe("failed");
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: turn.run.id } })).toMatchObject({ errorCode: "WAITPOINT_EXPIRED" });
    const blocks = ContentBlocksSchema.parse((await prisma.message.findUniqueOrThrow({ where: { id: turn.assistantMessage.id } })).contentBlocks);
    expect(blocks.filter((b) => b.type === "tool_call").map((b) => b.type === "tool_call" && b.status)).toEqual(["failed", "failed"]);
    expect(blocks.find((b) => b.type === "waitpoint")).toMatchObject({ status: "expired" });
    expect(await balance()).toEqual({ balance: 10_000_000, held: 0 });
  });

  it("never asks when no threshold is set", async () => {
    const { payload } = await setup();
    const { done } = await start(payload, [twoImages(), DONE], undefined);
    expect(await done).toBe("completed");
    expect(await prisma.waitpoint.count()).toBe(0);
  });
});
