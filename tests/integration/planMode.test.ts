import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContentBlocksSchema, CreateChatResponseSchema, SendMessageResponseSchema, type AgentStreamChunk, type ContentBlock } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { renderReply } from "#src/agent/context.js";
import type { AgentTurnPayload, MagicaToolPayload } from "#src/agent/payload.js";
import { systemPrompt } from "#src/agent/prompt.js";
import { runAgentTurn, type TurnDeps } from "#src/agent/runTurn.js";
import { loadSkillRegistry } from "#src/skills/registry.js";
import { SKILL_ROOTS } from "#src/skills/skills.js";
import { finalizeRun } from "#src/services/runs.js";
import { TOOL_CREDIT_COSTS } from "#src/tools/costs.js";
import { agentTools } from "#src/tools/index.js";
import { runMagicaInvocation } from "#src/tools/magicaInvocation.js";
import { planPayload } from "#src/tools/planTools.js";
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

const IMG = "https://g.tlcdn.com/gen/851fbf5cbc7546dcb9d22966b915153c.png"; // what the gpt_text fixture returns
const silent = pino({ level: "silent" });
const skills = loadSkillRegistry(SKILL_ROOTS, silent).metadata();

async function magica(polls: Reply[]) {
  const schema = (id: string): Reply[] => [{ status: 200, json: fixture(`schema.${id}.json`) }];
  const server = await startMagicaServer({
    "POST /v1/nodes/*/run": [{ status: 202, json: { runId: "mg_1" } }],
    "GET /v1/nodes/runs/*": polls,
    "GET /v1/models/gpt-image-2-text/schema": schema("gpt-image-2-text"),
    "GET /v1/models/crop_image/schema": schema("crop_image"),
  });
  servers.push(server);
  return server;
}
const completed = (name: string): Reply => ({ status: 200, json: fixture(`run.${name}.completed.json`) });

const FOX_PLAN = {
  title: "A fox, cropped",
  overview: "Generate a fox, then crop it to its top half.",
  steps: [
    { title: "Generate the fox", tool: "gpt_image_2", description: "A fox in the snow" },
    { title: "Crop to the top half", tool: "crop_image" },
    { title: "Show the result" },
  ],
  notes: "Square image.",
};
const RED_PLAN = { ...FOX_PLAN, title: "A red fox, cropped", overview: "Generate a red fox, then crop it to its top half." };
const propose = (plan: Record<string, unknown>, id = "PlanCall1") => [toolCall("propose_plan", plan, id), finished()];
const generate = [toolCall("gpt_image_2", { mode: "text", prompt: "A fox in the snow", quality: "low" }, "GenCall1"), finished()];
const crop = [toolCall("crop_image", { image_url: IMG, crop: { x: 0, y: 0, width: 100, height: 50, unit: "percent" } }, "CropCall1"), finished()];
const DONE = [text("Here is your fox."), finished()];

async function setup({ mode = "PLAN" }: { mode?: "PLAN" | "DEFAULT" } = {}) {
  const user = await fixtures.user({ id: "u1", balance: 10_000_000 });
  const chat = await fixtures.chat(user.id);
  const turn = await activeTurn(chat.id, user.id, { status: "PENDING", triggerRunId: null, ageMs: 1_000 });
  await prisma.agentRun.update({ where: { id: turn.run.id }, data: { mode } });
  await prisma.message.update({ where: { id: turn.run.triggerMessageId }, data: { content: "Make an image of a fox, then crop it" } });
  const payload: AgentTurnPayload = { agentRunId: turn.run.id, chatId: chat.id, userId: user.id, assistantMessageId: turn.assistantMessage.id, traceId: "trace_plan" };
  return { user, chat, turn, payload };
}

function start(payload: AgentTurnPayload, scripts: Script[], { magicaUrl = "http://127.0.0.1:9", maxSteps }: { magicaUrl?: string; maxSteps?: number } = {}) {
  const model = fakeModelSteps(scripts);
  const emitted: AgentStreamChunk[] = [];
  const batches: MagicaToolPayload[][] = [];
  const controller = new AbortController();
  const clock = fakeClockClient(magicaUrl);
  const deps: TurnDeps = {
    stream: model.stream,
    emit: (chunk) => void emitted.push(chunk),
    setStatus: () => undefined,
    triggerRunId: "run_trigger_plan",
    signal: controller.signal,
    flushEveryMs: 0,
    tools: {
      registry: agentTools,
      skills,
      waitpoints: fake.tokens,
      ...(maxSteps !== undefined && { maxSteps }),
      runMagicaCalls: async (calls) => {
        batches.push(calls);
        return Promise.all(calls.map((call) => runMagicaInvocation(call.invocationId, { client: clock.client, now: clock.now, registry: agentTools, log: silent, signal: controller.signal })));
      },
    },
  };
  return { done: runAgentTurn(payload, deps), model, emitted, batches, controller };
}

const pendingPlan = async (runId: string) => {
  await fake.someoneWaiting();
  return prisma.waitpoint.findFirstOrThrow({ where: { agentRunId: runId, status: "PENDING" } });
};
const answer = (id: string, body: object) => as("u1").post(`/api/waitpoints/${id}/respond`).send(body);
const toolMessages = (model: ReturnType<typeof fakeModelSteps>, step: number) =>
  (model.calls[step]?.messages ?? []).filter((m) => m.role === "tool").map((m) => JSON.parse((m as { content: string }).content) as Record<string, unknown>);
const offeredTo = (model: ReturnType<typeof fakeModelSteps>, step = 0) => model.calls[step]?.options?.tools?.map((t) => t.function.name);
const reply = async (id: string) => ContentBlocksSchema.parse((await prisma.message.findUniqueOrThrow({ where: { id } })).contentBlocks);
const failures = (emitted: AgentStreamChunk[]) => emitted.flatMap((c) => (c.type === "tool-end" && c.status === "failed" ? [c.errorMessage] : []));

describe("plan mode", () => {
  it("proposes, waits for Run All, then carries the whole plan out: estimates come from the tools' prices", async () => {
    const server = await magica([completed("gpt_text"), completed("crop")]);
    const { turn, payload } = await setup();
    const { done, model, batches } = start(payload, [propose(FOX_PLAN), generate, crop, DONE], { magicaUrl: server.url });

    const waiting = await pendingPlan(turn.run.id);
    expect(waiting.payload).toEqual({
      title: "A fox, cropped",
      overview: "Generate a fox, then crop it to its top half.",
      steps: [
        { title: "Generate the fox", tool: "gpt_image_2", description: "A fox in the snow", estimatedCredits: TOOL_CREDIT_COSTS.gpt_image_2 },
        { title: "Crop to the top half", tool: "crop_image", estimatedCredits: TOOL_CREDIT_COSTS.crop_image },
        { title: "Show the result", estimatedCredits: 0 },
      ],
      notes: "Square image.",
      totalCredits: 1_200_000,
    });
    expect(offeredTo(model)).toContain("propose_plan");
    expect(await prisma.toolInvocation.count()).toBe(0); // nothing paid before the answer

    expect((await answer(waiting.id, { action: "approve" })).status).toBe(200);
    expect(await done).toBe("completed");
    expect(toolMessages(model, 1)).toEqual([{ status: "approved", instruction: expect.stringContaining("Carry it out now") as unknown }]);
    expect(batches.map((batch) => batch.length)).toEqual([1, 1]); // the image, then the crop: one approval covers both
    expect(await prisma.toolInvocation.findMany({ orderBy: { createdAt: "asc" }, select: { toolName: true, status: true } })).toEqual([
      { toolName: "gpt_image_2", status: "COMPLETED" },
      { toolName: "crop_image", status: "COMPLETED" },
    ]);
    const blocks = await reply(turn.assistantMessage.id);
    expect(blocks.find((b) => b.type === "waitpoint")).toMatchObject({ waitpointType: "plan", status: "approved" });
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(2);
  });

  it("revises on Request Changes: the feedback reaches the agent, which proposes again, and the revised plan runs once approved", async () => {
    const server = await magica([completed("gpt_text")]);
    const { turn, payload } = await setup();
    const { done, model } = start(payload, [propose(FOX_PLAN), propose(RED_PLAN, "PlanCall2"), generate, DONE], { magicaUrl: server.url });

    const first = await pendingPlan(turn.run.id);
    expect((await answer(first.id, { action: "request_changes", feedback: "Make it a red fox" })).body).toMatchObject({ waitpoint: { status: "changes_requested" } });
    const second = await pendingPlan(turn.run.id);
    expect(second.id).not.toBe(first.id);
    expect(second.payload).toMatchObject({ title: "A red fox, cropped" });
    expect(toolMessages(model, 1)).toEqual([{ status: "changes_requested", feedback: "Make it a red fox", instruction: expect.stringContaining("Revise the plan") as unknown }]);
    expect(await prisma.toolInvocation.count()).toBe(0); // changes requested is not an approval

    await answer(second.id, { action: "approve" });
    expect(await done).toBe("completed");
    expect(await prisma.toolInvocation.count({ where: { status: "COMPLETED" } })).toBe(1);
    const cards = (await reply(turn.assistantMessage.id)).filter((b) => b.type === "waitpoint");
    expect(cards.map((card) => card.type === "waitpoint" && [card.status, card.feedback])).toEqual([
      ["changes_requested", "Make it a red fox"],
      ["approved", undefined],
    ]);
  });

  it("refuses a paid tool before a plan is approved, with a reason the agent can act on, and charges nothing", async () => {
    const { payload } = await setup();
    const { done, model, emitted } = start(payload, [generate, DONE]);
    expect(await done).toBe("completed");
    const reason = "Plan mode: propose a plan with propose_plan and wait for the user to approve it before using gpt_image_2.";
    expect(failures(emitted)).toEqual([reason]);
    expect(toolMessages(model, 1)).toEqual([{ error: reason }]);
    expect(await prisma.toolInvocation.count()).toBe(0);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: "u1" }, select: { balance: true, held: true } })).toEqual({ balance: 10_000_000, held: 0 });
  });

  it("refuses a paid tool asked for in the same step as the plan: approval comes first", async () => {
    const server = await magica([completed("gpt_text")]);
    const { turn, payload } = await setup();
    const { done, emitted, batches } = start(payload, [[toolCall("propose_plan", FOX_PLAN, "PlanCall1"), toolCall("gpt_image_2", { mode: "text", prompt: "A fox" }, "GenEarly"), finished()], generate, DONE], {
      magicaUrl: server.url,
    });
    const waiting = await pendingPlan(turn.run.id);
    await answer(waiting.id, { action: "approve" });
    expect(await done).toBe("completed");
    expect(failures(emitted)).toEqual([expect.stringContaining("Plan mode: propose a plan") as unknown]);
    expect(batches).toHaveLength(1); // only the call made after the approval
  });

  it("takes one plan at a time: a second plan in the same step is refused", async () => {
    const { turn, payload } = await setup();
    const { done, emitted } = start(payload, [[toolCall("propose_plan", FOX_PLAN, "PlanCallA"), toolCall("propose_plan", RED_PLAN, "PlanCallB"), finished()], DONE]);
    const waiting = await pendingPlan(turn.run.id);
    await answer(waiting.id, { action: "approve" });
    expect(await done).toBe("completed");
    expect(failures(emitted)).toEqual(["Propose one plan at a time, and wait for the answer to it."]);
    expect(await prisma.waitpoint.count()).toBe(1);
  });

  it("allows free tools (loading a skill) before the plan", async () => {
    const { turn, payload } = await setup();
    const { done, emitted } = start(payload, [[toolCall("load_skill", { name: "image-generation" }, "SkillCall1"), finished()], DONE]);
    expect(await done).toBe("completed");
    expect(failures(emitted)).toEqual([]);
    expect(await prisma.runSkill.count({ where: { agentRunId: turn.run.id } })).toBe(1);
  });

  it("just answers when the request needs no paid tool", async () => {
    const { turn, payload } = await setup();
    const { done } = start(payload, [[text("A fox is a small wild canine."), finished()]]);
    expect(await done).toBe("completed");
    expect(await prisma.waitpoint.count()).toBe(0);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: turn.assistantMessage.id } })).content).toBe("A fox is a small wild canine.");
  });

  it("stops at the step limit if the agent never proposes a plan, having spent nothing", async () => {
    const { turn, payload } = await setup();
    const { done } = start(payload, [generate], { maxSteps: 3 });
    expect(await done).toBe("failed");
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: turn.run.id } })).toMatchObject({ status: "FAILED", errorCode: "AGENT_MAX_STEPS" });
    expect(await prisma.toolInvocation.count()).toBe(0);
  });

  it.each([
    ["no steps", { ...FOX_PLAN, steps: [] }],
    ["a tool that doesn't exist", { ...FOX_PLAN, steps: [{ title: "Wipe", tool: "delete_everything" }] }],
    ["a free tool as a step", { ...FOX_PLAN, steps: [{ title: "Load", tool: "load_skill" }] }],
    ["more than 20 steps", { ...FOX_PLAN, steps: Array(21).fill({ title: "Again", tool: "crop_image" }) }],
    ["no title", { ...FOX_PLAN, title: " " }],
    ["its own estimates (ignored: the prices decide)", { ...FOX_PLAN, steps: [{ title: "Generate", tool: "gpt_image_2", estimatedCredits: 1 }] }],
  ])("checks the plan it is given: %s", async (label, plan) => {
    const { turn, payload } = await setup();
    const { done, emitted, controller } = start(payload, [propose(plan), DONE]);
    if (label.startsWith("its own estimates")) {
      const waiting = await pendingPlan(turn.run.id);
      expect(waiting.payload).toMatchObject({ steps: [{ estimatedCredits: TOOL_CREDIT_COSTS.gpt_image_2 }], totalCredits: TOOL_CREDIT_COSTS.gpt_image_2 });
      controller.abort();
      await done;
      return;
    }
    expect(await done).toBe("completed");
    expect(failures(emitted)).toEqual([expect.stringMatching(/^Invalid input for propose_plan: /) as unknown]);
    expect(await prisma.waitpoint.count()).toBe(0);
  });
});

describe("outside plan mode", () => {
  it("doesn't offer propose_plan, and refuses it if called anyway; paid tools run without a plan", async () => {
    const server = await magica([completed("gpt_text")]);
    const { payload } = await setup({ mode: "DEFAULT" });
    const { done, model, emitted } = start(payload, [propose(FOX_PLAN), generate, DONE], { magicaUrl: server.url });
    expect(await done).toBe("completed");
    expect(offeredTo(model)).not.toContain("propose_plan");
    expect(failures(emitted)).toEqual(["propose_plan is only for plan mode. Do what the user asked directly."]);
    expect(await prisma.waitpoint.count()).toBe(0);
    expect(await prisma.toolInvocation.count({ where: { status: "COMPLETED" } })).toBe(1);
  });

  it("tells the model about plan mode only in plan mode", () => {
    const tools = agentTools.functions().map((f) => ({ name: f.function.name, description: f.function.description }));
    expect(systemPrompt(new Date(0), { skills, tools }, "plan")).toMatch(/## Plan mode\nThe user turned on plan mode\. Before using any tool that costs credits/);
    expect(systemPrompt(new Date(0), { skills, tools }, "default")).not.toMatch(/## Plan mode/);
    expect(systemPrompt(new Date(0), undefined, "plan")).not.toMatch(/## Plan mode/); // no tools, nothing to plan
  });
});

describe("a later turn", () => {
  const card = (status: "approved" | "changes_requested" | "expired" | "cancelled", feedback?: string): ContentBlock => ({
    type: "waitpoint",
    waitpointId: "w1",
    waitpointType: "plan",
    payload: planPayload({ title: "A fox, cropped", overview: "Fox", steps: [{ title: "Generate", tool: "gpt_image_2" }] }),
    status,
    expiresAt: "2026-10-02T12:30:00.000Z",
    ...(feedback && { feedback }),
  });

  it("knows what became of a plan", () => {
    expect(renderReply([card("approved"), { type: "text", content: "Done." }], null, true)).toBe('Done.\n[Plan "A fox, cropped" approved]');
    expect(renderReply([card("changes_requested", "Make it red")], null, false)).toBe('[Plan "A fox, cropped" changes requested: Make it red]');
    expect(renderReply([card("expired")], null, false)).toBe('[Plan "A fox, cropped" expired without an answer]');
    const spend: ContentBlock = { type: "waitpoint", waitpointId: "w2", waitpointType: "credit", payload: { calls: [{ toolCallId: "a", toolName: "gpt_image_2", credits: 3_000_000 }], totalCredits: 3_000_000 }, status: "rejected", expiresAt: "2026-10-02T12:30:00.000Z" };
    expect(renderReply([spend], null, false)).toBe("[Spend of 3000000 credits declined]");
  });
});

describe("sending and retrying in plan mode", () => {
  async function chat() {
    await fixtures.user({ id: "u1", balance: 10_000_000 });
    return CreateChatResponseSchema.parse((await as("u1").post("/api/chats").send({})).body).chat.id;
  }
  async function send(chatId: string, body: Record<string, unknown>) {
    const res = await as("u1").post(`/api/chats/${chatId}/messages`).send(body);
    return { status: res.status, body: res.body as unknown, runId: res.status < 300 ? SendMessageResponseSchema.parse(res.body).runId : "" };
  }
  const modeOf = (runId: string) => prisma.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { mode: true } });

  it("records the mode on the run (default unless asked)", async () => {
    const chatId = await chat();
    const planned = await send(chatId, { content: "Plan it", mode: "plan" });
    expect(planned.status).toBe(201);
    expect(await modeOf(planned.runId)).toEqual({ mode: "PLAN" });
    await finalizeRun(planned.runId, { status: "COMPLETED" });
    expect(await modeOf((await send(chatId, { content: "Just do it" })).runId)).toEqual({ mode: "DEFAULT" });
  });

  it("keeps plan mode on a retry", async () => {
    const chatId = await chat();
    const { runId } = await send(chatId, { content: "Plan it", mode: "plan" });
    await finalizeRun(runId, { status: "FAILED", errorCode: "WAITPOINT_EXPIRED", errorMessage: "This approval expired. Send a new message to continue." });
    const retried = await as("u1").post(`/api/runs/${runId}/retry`);
    expect(retried.status).toBe(201);
    expect(await modeOf(SendMessageResponseSchema.parse(retried.body).runId)).toEqual({ mode: "PLAN" });
  });

  it("treats a resend with the same id but another mode as a different message", async () => {
    const chatId = await chat();
    const clientMessageId = "0b4f6f3e-3c2e-4a8e-9a55-7c0d7c1d2e3f";
    const first = await send(chatId, { content: "Plan it", mode: "plan", clientMessageId });
    const again = await send(chatId, { content: "Plan it", mode: "plan", clientMessageId });
    expect([first.status, again.status, again.runId]).toEqual([201, 200, first.runId]);
    const other = await send(chatId, { content: "Plan it", clientMessageId });
    expect(other.status).toBe(400);
    expect(other.body).toMatchObject({ code: "VALIDATION_FAILED", error: "clientMessageId: That id was already used for a different message." });
  });
});
