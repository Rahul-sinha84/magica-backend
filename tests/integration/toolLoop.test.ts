import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContentBlocksSchema, type AgentStreamChunk, type AgentStreamMetadata } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { endAfterCancel } from "#src/agent/outcomes.js";
import type { AgentTurnPayload, MagicaToolPayload } from "#src/agent/payload.js";
import { runAgentTurn, type TurnDeps } from "#src/agent/runTurn.js";
import { loadSkillRegistry } from "#src/skills/registry.js";
import { SKILL_ROOTS } from "#src/skills/skills.js";
import { reconcileRun, MAX_RUN_MS } from "#src/services/reconcile.js";
import { findActiveRun } from "#src/services/runs.js";
import { TOOL_CREDIT_COSTS } from "#src/tools/costs.js";
import { agentTools } from "#src/tools/index.js";
import { runMagicaInvocation } from "#src/tools/magicaInvocation.js";
import { activeTurn, fixtures, resetDb } from "../helpers/db.js";
import { fakeModelSteps, finished, text, toolCall, type Script } from "../helpers/fakeModel.js";
import { fakeClockClient, fixture, startMagicaServer, type Reply } from "../helpers/magicaServer.js";

beforeEach(resetDb);
const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const IMG = "https://g.tlcdn.com/gen/851fbf5cbc7546dcb9d22966b915153c.png"; // what the gpt_text fixture returns
const CROPPED = "https://g.tlcdn.com/gen/7a3cc3bbb328407abd6b35a494a4e632.png";
// what the fixtures' Magica runs report they used: each call is charged exactly this (one credit each), not its estimate
const IMAGE_COST = 7644;
const CROP_COST = 5000;
const ADMISSION = 100_000; // what a turn holds to start
const silent = pino({ level: "silent" });
const skills = loadSkillRegistry(SKILL_ROOTS, silent).metadata();

async function magica(polls: Reply[] = [], start: Reply[] = [{ status: 202, json: { runId: "mg_1" } }]) {
  const schema = (id: string): Reply[] => [{ status: 200, json: fixture(`schema.${id}.json`) }];
  const server = await startMagicaServer({
    "POST /v1/nodes/*/run": start,
    "GET /v1/nodes/runs/*": polls,
    "GET /v1/models/gpt-image-2-text/schema": schema("gpt-image-2-text"),
    "GET /v1/models/gpt-image-2-edit/schema": schema("gpt-image-2-edit"),
    "GET /v1/models/crop_image/schema": schema("crop_image"),
    "GET /v1/models/merge_videos/schema": schema("merge_videos"),
  });
  servers.push(server);
  return server;
}
const completed = (name: string): Reply => ({ status: 200, json: fixture(`run.${name}.completed.json`) });

async function setup({ balance = 10_000_000, question = "Please help", earlier = [] as { role: "USER" | "ASSISTANT"; content: string; blocks?: unknown[] }[] } = {}) {
  const user = await fixtures.user({ id: "u1", balance });
  const chat = await fixtures.chat(user.id);
  let at = Date.now() - 60_000;
  for (const message of earlier) {
    await prisma.message.create({ data: { chatId: chat.id, userId: user.id, role: message.role, content: message.content, contentBlocks: (message.blocks ?? []) as never, createdAt: new Date((at += 1_000)) } });
  }
  const turn = await activeTurn(chat.id, user.id, { status: "PENDING", triggerRunId: null, ageMs: 1_000 });
  await prisma.message.update({ where: { id: turn.run.triggerMessageId }, data: { content: question } });
  const payload: AgentTurnPayload = { agentRunId: turn.run.id, chatId: chat.id, userId: user.id, assistantMessageId: turn.assistantMessage.id, traceId: "trace_loop" };
  return { user, chat, turn, payload };
}

async function run(payload: AgentTurnPayload, scripts: Script[], { magicaUrl, maxSteps, controller = new AbortController() }: { magicaUrl?: string; maxSteps?: number; controller?: AbortController } = {}) {
  const model = fakeModelSteps(scripts);
  const emitted: AgentStreamChunk[] = [];
  const statuses: AgentStreamMetadata[] = [];
  const batches: MagicaToolPayload[][] = [];
  const clock = fakeClockClient(magicaUrl ?? "http://127.0.0.1:9");
  const deps: TurnDeps = {
    stream: model.stream,
    emit: (chunk) => void emitted.push(chunk),
    setStatus: (status) => void statuses.push(status),
    triggerRunId: "run_trigger_1",
    signal: controller.signal,
    flushEveryMs: 0,
    tools: {
      registry: agentTools,
      skills,
      ...(maxSteps !== undefined && { maxSteps }),
      runMagicaCalls: async (calls) => {
        batches.push(calls);
        return Promise.all(calls.map((call) => runMagicaInvocation(call.invocationId, { client: clock.client, now: clock.now, registry: agentTools, log: silent, signal: controller.signal })));
      },
    },
  };
  const result = await runAgentTurn(payload, deps);
  return { result, model, emitted, statuses, batches };
}

const reply = async (id: string) => {
  const row = await prisma.message.findUniqueOrThrow({ where: { id } });
  return { ...row, blocks: ContentBlocksSchema.parse(row.contentBlocks) };
};
const runRow = (id: string) => prisma.agentRun.findUniqueOrThrow({ where: { id } });
const credits = async () => prisma.user.findUniqueOrThrow({ where: { id: "u1" }, select: { balance: true, held: true } });
const typesOf = (blocks: { type: string }[]) => blocks.map((b) => b.type);

describe("a turn with tools offered", () => {
  it("answers in text when no tool is needed, offering every tool and listing them in the prompt", async () => {
    const { turn, payload } = await setup({ question: "What is 2 + 2?" });
    const { result, model } = await run(payload, [[text("4"), finished()]]);
    expect(result).toBe("completed");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.options?.tools?.map((t) => t.function.name)).toEqual(["load_skill", "read_skill_asset", "gpt_image_2", "crop_image", "merge_videos"]);
    expect(model.calls[0]?.messages[0]?.role === "system" && model.calls[0].messages[0].content).toMatch(/## Tools[\s\S]*## Skills/);
    expect(await reply(turn.assistantMessage.id)).toMatchObject({ status: "COMPLETED", content: "4" });
  });

  it("runs a tool, feeds the result back, and finishes with the model's answer", async () => {
    const { turn, payload } = await setup({ question: "Help me edit an image" });
    const { result, model, emitted } = await run(payload, [[toolCall("load_skill", { name: "image-editing" }, "SkillCall1"), finished()], [text("I loaded the guide."), finished()]]);
    expect(result).toBe("completed");
    // step 2 sees the call and its result, the result carrying the full guidance
    const step2 = model.calls[1]?.messages ?? [];
    expect(step2.at(-2)).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "SkillCall1", type: "function", function: { name: "load_skill", arguments: '{"name":"image-editing"}' } }] });
    expect(step2.at(-1)).toMatchObject({ role: "tool", tool_call_id: "SkillCall1" });
    expect(JSON.parse((step2.at(-1) as { content: string }).content)).toMatchObject({ skill: "image-editing", instructions: expect.stringContaining("Image editing") as unknown });

    expect(emitted.filter((c) => c.type === "tool-start" || c.type === "tool-end")).toEqual([
      { type: "tool-start", toolCallId: "s1-SkillCall1", toolName: "load_skill", toolInput: { name: "image-editing" } },
      { type: "tool-end", toolCallId: "s1-SkillCall1", status: "completed", durationMs: expect.any(Number) as unknown, creditCost: 0, result: { skill: "image-editing", loaded: true } },
    ]);
    const saved = await reply(turn.assistantMessage.id);
    expect(typesOf(saved.blocks)).toEqual(["tool_call", "tool_result", "text", "usage"]);
    expect(saved.blocks[0]).toMatchObject({ type: "tool_call", toolName: "load_skill", status: "completed" });
    expect(await prisma.runSkill.count({ where: { agentRunId: turn.run.id } })).toBe(1);
  });

  it("generates an image end to end: the asset streams for the artifact panel, is saved, and is charged once", async () => {
    const server = await magica([completed("gpt_text")]);
    const { turn, payload } = await setup({ question: "Generate an image of a sunset" });
    const { result, emitted, batches } = await run(
      payload,
      [
        [toolCall("load_skill", { name: "image-generation" }, "Step1call"), finished("m/one", 10, 5)],
        [text("Generating it now. "), toolCall("gpt_image_2", { mode: "text", prompt: "A sunset over the sea", quality: "low" }, "Step2call"), finished("m/two", 20, 6)],
        [text("Here is your sunset."), finished("m/three", 30, 7)],
      ],
      { magicaUrl: server.url },
    );
    expect(result).toBe("completed");
    expect(batches).toHaveLength(1);
    expect(emitted.find((c) => c.type === "asset")).toEqual({ type: "asset", asset: { type: "image", url: IMG, model: "GPT Image 2", prompt: "A sunset over the sea", mimeType: "image/png", width: 1024, height: 1024 } });

    const saved = await reply(turn.assistantMessage.id);
    expect(typesOf(saved.blocks)).toEqual(["tool_call", "tool_result", "text", "tool_call", "tool_result", "image", "text", "usage"]);
    expect(saved.content).toBe("Generating it now. Here is your sunset.");
    expect(saved.blocks.at(-1)).toEqual({ type: "usage", inputTokens: 60, outputTokens: 18, model: "m/three", creditCost: IMAGE_COST });
    // the card shows what the image really cost, live and once saved, not the estimate held while it ran
    expect(TOOL_CREDIT_COSTS.gpt_image_2).not.toBe(IMAGE_COST);
    expect(emitted.find((c) => c.type === "tool-end" && c.toolCallId === "s2-Step2call")).toMatchObject({ status: "completed", creditCost: IMAGE_COST });
    expect(saved.blocks.find((b) => b.type === "tool_call" && b.toolName === "gpt_image_2")).toMatchObject({ status: "completed", creditCost: IMAGE_COST });
    expect(await runRow(turn.run.id)).toMatchObject({ status: "COMPLETED", model: "m/three", inputTokens: 60, outputTokens: 18 });
    expect(await credits()).toEqual({ balance: 10_000_000 - IMAGE_COST, held: 0 });
    expect(await prisma.toolInvocation.findMany({ select: { toolCallId: true, status: true, creditCost: true } })).toEqual([{ toolCallId: "s2-Step2call", status: "COMPLETED", creditCost: IMAGE_COST }]);
  });

  it("runs independent calls in one step together, once each, and feeds the results back in call order", async () => {
    const server = await magica([completed("crop")]);
    const urls = ["https://a.test/1.mp4", "https://a.test/2.mp4"];
    const { payload } = await setup({ question: `Crop ${IMG} and merge ${urls.join(" ")}` });
    const { result, model, batches } = await run(
      payload,
      [[toolCall("crop_image", { image_url: IMG, crop: { x: 0, y: 0, width: 100, height: 50 } }, "callCropA"), toolCall("merge_videos", { video_urls: urls }, "callMergB"), finished()], [text("Both done."), finished()]],
      { magicaUrl: server.url },
    );
    expect(result).toBe("completed");
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2); // one batch, both calls
    expect(server.count("POST")).toBe(2);
    const toolMessages = (model.calls[1]?.messages ?? []).filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.role === "tool" && m.tool_call_id)).toEqual(["callCropA", "callMergB"]);
  });

  it("keeps going after a tool fails: the model reads the error and answers", async () => {
    const server = await magica([], [{ status: 401, json: fixture("error.401.json") }]);
    const { turn, payload } = await setup({ question: "Generate a fox" });
    const { result, model } = await run(payload, [[toolCall("gpt_image_2", { mode: "text", prompt: "A fox" }, "FailCall1"), finished()], [text("Sorry, the image service failed."), finished()]], { magicaUrl: server.url });
    expect(result).toBe("completed");
    expect(JSON.parse((model.calls[1]?.messages.at(-1) as { content: string }).content)).toEqual({ error: "Authentication error with the media service." });
    const saved = await reply(turn.assistantMessage.id);
    expect(saved.blocks.find((b) => b.type === "tool_result")).toMatchObject({ isError: true, errorMessage: "Authentication error with the media service." });
    expect(await credits()).toEqual({ balance: 10_000_000, held: 0 });
  });
});

describe("tool calls that can't run", () => {
  it("a malformed call: the model is told why and the loop continues", async () => {
    const { payload } = await setup();
    const malformed = { type: "tool-call" as const, id: "BadArgs01", name: "crop_image", arguments: "{}", malformed: "the arguments are not valid JSON" };
    const { result, model } = await run(payload, [[malformed, finished()], [text("Let me try again later."), finished()]]);
    expect(result).toBe("completed");
    expect(JSON.parse((model.calls[1]?.messages.at(-1) as { content: string }).content)).toEqual({ error: "Invalid tool call: the arguments are not valid JSON." });
    expect(await prisma.toolInvocation.count()).toBe(0);
  });

  it("an unknown tool", async () => {
    const { payload } = await setup();
    const { model } = await run(payload, [[toolCall("delete_everything", {}, "Unknown01"), finished()], [text("ok"), finished()]]);
    expect(JSON.parse((model.calls[1]?.messages.at(-1) as { content: string }).content)).toEqual({ error: "Unknown tool: delete_everything" });
  });

  it("input the tool's contract refuses", async () => {
    const { payload } = await setup({ question: `Crop ${IMG}` });
    const { model } = await run(payload, [[toolCall("crop_image", { image_url: IMG, crop: { x: 80, y: 0, width: 50, height: 10 } }, "BadCrop01"), finished()], [text("ok"), finished()]]);
    expect((JSON.parse((model.calls[1]?.messages.at(-1) as { content: string }).content) as { error: string }).error).toMatch(/x \+ width must not exceed 100%/);
  });
});

describe("the URL guard", () => {
  it("refuses a link that isn't in the conversation, before anything is sent or charged", async () => {
    const server = await magica([completed("crop")]);
    const { payload } = await setup({ question: `Crop ${IMG} to the top half` });
    const garbled = IMG.replace("15153c", "1515c");
    const { model } = await run(payload, [[toolCall("crop_image", { image_url: garbled, crop: { x: 0, y: 0, width: 100, height: 50 } }, "Garbled01"), finished()], [text("ok"), finished()]], { magicaUrl: server.url });
    expect(JSON.parse((model.calls[1]?.messages.at(-1) as { content: string }).content)).toEqual({ error: `This link doesn't appear in the conversation: ${garbled}. Use the exact link from the conversation.` });
    expect(server.count("POST")).toBe(0);
    expect(await prisma.toolInvocation.count()).toBe(0);
    expect(await credits()).toEqual({ balance: 10_000_000, held: 0 });
  });

  it("accepts the exact link from the user's message, even with punctuation around it", async () => {
    const server = await magica([completed("crop")]);
    const { payload } = await setup({ question: `Please crop this (${IMG}).` });
    const { model } = await run(payload, [[toolCall("crop_image", { image_url: IMG, crop: { x: 0, y: 0, width: 100, height: 50 } }, "CropOk001"), finished()], [text("Cropped."), finished()]], { magicaUrl: server.url });
    expect(JSON.parse((model.calls[1]?.messages.at(-1) as { content: string }).content)).toMatchObject({ image: { url: CROPPED } });
  });

  it("accepts media an earlier turn generated (it appears in the history)", async () => {
    const server = await magica([completed("crop")]);
    const { payload } = await setup({
      question: "Now crop it to the top half",
      earlier: [
        { role: "USER", content: "Draw a fox" },
        { role: "ASSISTANT", content: "Here it is.", blocks: [{ type: "text", content: "Here it is." }, { type: "image", url: IMG }] },
      ],
    });
    const { result, model } = await run(payload, [[toolCall("crop_image", { image_url: IMG, crop: { x: 0, y: 0, width: 100, height: 50 } }, "Chained01"), finished()], [text("Done."), finished()]], { magicaUrl: server.url });
    expect(result).toBe("completed");
    expect(model.calls[0]?.messages.some((m) => m.role === "assistant" && m.content?.includes(`[Generated image: ${IMG}]`))).toBe(true);
    expect(server.count("POST")).toBe(1);
  });

  it("accepts media this same turn generated, in a later step (generate, then crop)", async () => {
    const server = await magica([completed("gpt_text"), completed("crop")]);
    const { payload } = await setup({ question: "Draw a fox, then crop it" });
    const { result } = await run(
      payload,
      [
        [toolCall("gpt_image_2", { mode: "text", prompt: "A fox" }, "Generate1"), finished()],
        [toolCall("crop_image", { image_url: IMG, crop: { x: 0, y: 0, width: 100, height: 50 } }, "CropAfter"), finished()],
        [text("Drawn and cropped."), finished()],
      ],
      { magicaUrl: server.url },
    );
    expect(result).toBe("completed");
    expect(server.count("POST")).toBe(2);
    expect(await credits()).toEqual({ balance: 10_000_000 - IMAGE_COST - CROP_COST, held: 0 });
  });
});

describe("files the user attached", () => {
  const ATTACHED = "https://pub-test.r2.dev/ws/asm/photo.png";
  async function attach(userId: string, messageId: string, expiresAt: Date) {
    const asset = await prisma.mediaAsset.create({ data: { userId, source: "UPLOAD", type: "IMAGE", url: ATTACHED, name: "photo.png", expiresAt } });
    await prisma.attachment.create({ data: { messageId, mediaAssetId: asset.id, position: 0 } });
  }

  it("are in the question the model reads, and its tools can use them", async () => {
    const server = await magica([completed("crop")]);
    const { user, turn, payload } = await setup({ question: "Crop my photo to the top half" });
    await attach(user.id, turn.run.triggerMessageId, new Date(Date.now() + 3_600_000));
    const { result, model } = await run(
      payload,
      [[toolCall("crop_image", { image_url: ATTACHED, crop: { x: 0, y: 0, width: 100, height: 50 } }, "CropFile1"), finished()], [text("Cropped."), finished()]],
      { magicaUrl: server.url },
    );
    expect(result).toBe("completed");
    const question = model.calls[0]?.messages.at(-1);
    expect(question?.role === "user" && question.content).toBe(`Crop my photo to the top half\n[Attached image: ${ATTACHED}]`);
    expect(server.requests.find((r) => r.method === "POST")?.body).toMatchObject({ input: { image_url: ATTACHED } });
  });

  it("refuses the link of a file that has expired: it isn't in the conversation any more", async () => {
    const server = await magica([completed("crop")]);
    const { user, turn, payload } = await setup({ question: "Crop my photo" });
    await attach(user.id, turn.run.triggerMessageId, new Date(Date.now() - 1_000));
    const { model } = await run(
      payload,
      [[toolCall("crop_image", { image_url: ATTACHED, crop: { x: 0, y: 0, width: 100, height: 50 } }, "CropGone1"), finished()], [text("That file expired."), finished()]],
      { magicaUrl: server.url },
    );
    const question = model.calls[0]?.messages.at(-1);
    expect(question?.role === "user" && question.content).toBe("Crop my photo\n[Attached image (expired)]");
    expect(JSON.parse((model.calls[1]?.messages.at(-1) as { content: string }).content)).toEqual({ error: `This link doesn't appear in the conversation: ${ATTACHED}. Use the exact link from the conversation.` });
    expect(server.count("POST")).toBe(0);
  });
});

describe("limits", () => {
  it("stops at the step limit with a clear failure, keeping what it did", async () => {
    const { turn, payload } = await setup();
    const { result, model } = await run(payload, [[toolCall("load_skill", { name: "image-editing" }, "Looping01"), finished()]], { maxSteps: 3 });
    expect(result).toBe("failed");
    expect(model.calls).toHaveLength(3);
    expect(await runRow(turn.run.id)).toMatchObject({ status: "FAILED", errorCode: "AGENT_MAX_STEPS", errorMessage: "The agent reached its step limit before finishing. What it did so far is kept." });
    const saved = await reply(turn.assistantMessage.id);
    expect(saved.blocks.filter((b) => b.type === "tool_call")).toHaveLength(2); // the 3rd step's call was not run
  });

  it("stops safely when credits run out mid-turn: nothing more is sent, completed work stays charged", async () => {
    const server = await magica([completed("crop")]);
    // enough to start and to hold the crop's estimate; after the crop is paid, too little for the image's estimate
    const balance = ADMISSION + TOOL_CREDIT_COSTS.crop_image + TOOL_CREDIT_COSTS.gpt_image_2 - 10_000;
    const { turn, payload } = await setup({ balance, question: `Crop ${IMG}, then make a new image` });
    const { result } = await run(
      payload,
      [
        [toolCall("crop_image", { image_url: IMG, crop: { x: 0, y: 0, width: 100, height: 50 } }, "CropFirst"), finished()],
        [toolCall("gpt_image_2", { mode: "text", prompt: "A fox" }, "TooPricey"), finished()],
        [text("never"), finished()],
      ],
      { magicaUrl: server.url },
    );
    expect(result).toBe("failed");
    expect(await runRow(turn.run.id)).toMatchObject({ status: "FAILED", errorCode: "INSUFFICIENT_CREDITS" });
    expect(server.count("POST")).toBe(1); // only the crop
    expect(await credits()).toEqual({ balance: balance - CROP_COST, held: 0 }); // the crop is paid for, nothing else held
    const saved = await reply(turn.assistantMessage.id);
    expect(saved.blocks.find((b) => b.type === "tool_result" && b.toolName === "gpt_image_2")).toMatchObject({ isError: true, errorMessage: "You don't have enough credits for this." });
    expect(saved.blocks.some((b) => b.type === "image" && b.url === CROPPED)).toBe(true);
  });

  it("sends none of a step it can't pay for in full, giving back what it reserved for it", async () => {
    const server = await magica([completed("crop")]);
    const balance = ADMISSION + TOOL_CREDIT_COSTS.gpt_image_2; // the image's estimate fits, the crop's doesn't
    const { payload } = await setup({ balance, question: `Crop ${IMG} and draw a fox` });
    await run(payload, [[toolCall("gpt_image_2", { mode: "text", prompt: "A fox" }, "Affordabl"), toolCall("crop_image", { image_url: IMG, crop: { x: 0, y: 0, width: 50, height: 50 } }, "NotAfford"), finished()]], { magicaUrl: server.url });
    expect(server.count("POST")).toBe(0);
    expect(await credits()).toEqual({ balance, held: 0 });
    expect(await prisma.toolInvocation.findMany({ select: { status: true, errorMessage: true } })).toEqual([{ status: "CANCELLED", errorMessage: "Stopped: not enough credits." }]);
  });
});

describe("stopping and recovery", () => {
  it("a stop during a tool: the turn stops, the call is cancelled, nothing is charged", async () => {
    // each status check takes half a second of real time, so the stop lands while the tool is being waited on
    const server = await magica([{ status: 200, json: { ...fixture<Record<string, unknown>>("run.gpt_text.running.json"), status: "RUNNING" }, delayMs: 500 }]);
    const { turn, payload } = await setup({ question: "Draw a fox" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("stopped by the user", "AbortError")), 200);
    const { result } = await run(payload, [[toolCall("gpt_image_2", { mode: "text", prompt: "A fox" }, "StopMe001"), finished()], [text("never"), finished()]], { magicaUrl: server.url, controller });
    expect(result).toBe("cancelled");
    await endAfterCancel(turn.run.id); // what the task's cancel hook does
    expect(await runRow(turn.run.id)).toMatchObject({ status: "CANCELLED" });
    expect(await prisma.toolInvocation.findMany({ select: { status: true } })).toEqual([{ status: "CANCELLED" }]);
    expect(await credits()).toEqual({ balance: 10_000_000, held: 0 });
    // the saved reply doesn't show the tool spinning forever
    const blocks = (await reply(turn.assistantMessage.id)).blocks;
    expect(blocks.find((b) => b.type === "tool_call")).toMatchObject({ status: "failed" });
    expect(blocks.find((b) => b.type === "tool_result")).toMatchObject({ isError: true, errorMessage: "Stopped." });
  });

  it("a reload mid-tool shows the tool card running (the reply is saved as soon as tools start)", async () => {
    const server = await magica([completed("gpt_text")]);
    const { turn, payload } = await setup({ question: "Draw a fox" });
    let seenWhileRunning: string[] = [];
    const model = fakeModelSteps([[toolCall("gpt_image_2", { mode: "text", prompt: "A fox" }, "Reload001"), finished()], [text("Here."), finished()]]);
    const clock = fakeClockClient(server.url);
    await runAgentTurn(payload, {
      stream: model.stream,
      emit: () => undefined,
      setStatus: () => undefined,
      triggerRunId: "t",
      signal: new AbortController().signal,
      flushEveryMs: 1_000_000, // no time-based saves: only the tool checkpoint can save it
      tools: {
        registry: agentTools,
        skills,
        runMagicaCalls: async (calls) => {
          const active = await findActiveRun(payload.chatId);
          seenWhileRunning = ContentBlocksSchema.parse(active?.assistantMessage.contentBlocks).map((b) => (b.type === "tool_call" ? `${b.type}:${b.status}` : b.type));
          return Promise.all(calls.map((c) => runMagicaInvocation(c.invocationId, { client: clock.client, now: clock.now, registry: agentTools, log: silent })));
        },
      },
    });
    expect(seenWhileRunning).toEqual(["tool_call:running"]);
    expect(typesOf((await reply(turn.assistantMessage.id)).blocks)).toEqual(["tool_call", "tool_result", "image", "text", "usage"]);
  });

  it("reports the running tool in the status, then says explicitly that it finished", async () => {
    const { payload } = await setup();
    const { statuses } = await run(payload, [[toolCall("load_skill", { name: "video-merging" }, "Status001"), finished()], [text("ok"), finished()]]);
    const tool = statuses.filter((s) => s.currentTool).map((s) => s.currentTool?.status);
    expect(tool).toEqual(["running", "completed"]);
    expect(statuses.find((s) => s.currentTool?.status === "running")).toEqual({ status: "working", currentTool: { name: "load_skill", input: { name: "video-merging" }, status: "running" } });
  });

  it("reports a failed tool as failed in the status", async () => {
    const server = await magica([], [{ status: 401, json: fixture("error.401.json") }]);
    const { payload } = await setup({ question: "Draw a fox" });
    const { statuses } = await run(payload, [[toolCall("gpt_image_2", { mode: "text", prompt: "A fox" }, "StatFail1"), finished()], [text("Sorry."), finished()]], { magicaUrl: server.url });
    expect(statuses.filter((s) => s.currentTool).map((s) => s.currentTool?.status)).toEqual(["running", "failed"]);
  });

  it("completes on the tools' results when the model adds nothing after them (the real client reports that as empty)", async () => {
    const server = await magica([completed("gpt_text")]);
    const { turn, payload } = await setup({ question: "Draw a fox" });
    const { ModelError } = await import("#src/lib/openrouter.js");
    const { result } = await run(payload, [[toolCall("gpt_image_2", { mode: "text", prompt: "A fox" }, "EmptyAfter"), finished()], [{ fail: new ModelError("EMPTY", "the stream ended without any content", true) }]], { magicaUrl: server.url });
    expect(result).toBe("completed");
    expect(await runRow(turn.run.id)).toMatchObject({ status: "COMPLETED" });
    expect((await reply(turn.assistantMessage.id)).blocks.some((b) => b.type === "image")).toBe(true);
    expect(await credits()).toEqual({ balance: 10_000_000 - IMAGE_COST, held: 0 });
  });

  it("still fails as empty when the model says nothing and no tool ran", async () => {
    const { turn, payload } = await setup();
    const { ModelError } = await import("#src/lib/openrouter.js");
    const { result } = await run(payload, [[{ fail: new ModelError("EMPTY", "nothing", true) }]]);
    expect(result).toBe("failed");
    expect(await runRow(turn.run.id)).toMatchObject({ status: "FAILED", errorCode: "MODEL_EMPTY" });
  });

  it("still fails when the model breaks off after tools for another reason, keeping the tools' results", async () => {
    const server = await magica([completed("gpt_text")]);
    const { turn, payload } = await setup({ question: "Draw a fox" });
    const { ModelError } = await import("#src/lib/openrouter.js");
    const { result } = await run(payload, [[toolCall("gpt_image_2", { mode: "text", prompt: "A fox" }, "Interrupt"), finished()], [text("Here is"), { fail: new ModelError("INTERRUPTED", "cut", false) }]], { magicaUrl: server.url });
    expect(result).toBe("failed");
    expect(await runRow(turn.run.id)).toMatchObject({ status: "FAILED", errorCode: "MODEL_INTERRUPTED" });
    expect((await reply(turn.assistantMessage.id)).blocks.some((b) => b.type === "image")).toBe(true);
    expect(await credits()).toEqual({ balance: 10_000_000 - IMAGE_COST, held: 0 }); // the image was made, so it stays paid for
  });

  it("ends a turn with only tool results (no final text) as completed, not as an empty answer", async () => {
    const server = await magica([completed("gpt_text")]);
    const { turn, payload } = await setup({ question: "Draw a fox" });
    const { result } = await run(payload, [[toolCall("gpt_image_2", { mode: "text", prompt: "A fox" }, "OnlyTool1"), finished()], [finished()]], { magicaUrl: server.url });
    // a final step with no content is an empty stream for the real client; here the fake yields only "done"
    expect(result).toBe("completed");
    expect((await reply(turn.assistantMessage.id)).blocks.some((b) => b.type === "image")).toBe(true);
  });
});

describe("the stale-run rule with tools", () => {
  async function longRun(dispatchedAgoMs: number) {
    const user = await fixtures.user({ id: "u1" });
    const chat = await fixtures.chat(user.id);
    const turn = await activeTurn(chat.id, user.id, { status: "RUNNING", triggerRunId: "run_long", ageMs: MAX_RUN_MS + 60_000, quietMs: 60_000, startedAt: new Date(Date.now() - MAX_RUN_MS - 60_000) });
    await prisma.toolInvocation.create({ data: { userId: user.id, agentRunId: turn.run.id, toolCallId: "s1-x", toolName: "gpt_image_2", input: {}, status: "RUNNING", dispatchedAt: new Date(Date.now() - dispatchedAgoMs), magicaRunId: "mg" } });
    return turn;
  }

  it("doesn't end a long turn that is waiting on a tool call still within its own limit", async () => {
    const turn = await longRun(2 * 60_000);
    const active = await findActiveRun(turn.run.chatId);
    expect(await reconcileRun(active!)).toBe(false);
    expect(await runRow(turn.run.id)).toMatchObject({ status: "RUNNING" });
  });

  it("ends it once the tool call itself is past its limit", async () => {
    const turn = await longRun(9 * 60_000);
    const active = await findActiveRun(turn.run.chatId);
    expect(await reconcileRun(active!)).toBe(true);
    expect(await runRow(turn.run.id)).toMatchObject({ status: "FAILED", errorCode: "AGENT_TIMEOUT" });
    expect(await prisma.toolInvocation.findMany({ select: { status: true } })).toEqual([{ status: "CANCELLED" }]);
  });
});

describe("tool cards when a turn ends without finishing", () => {
  const running = [
    { type: "text", content: "Working on it. " },
    { type: "tool_call", toolCallId: "s1-a", toolName: "gpt_image_2", toolInput: { prompt: "fox" }, status: "running" },
    { type: "tool_call", toolCallId: "s1-b", toolName: "load_skill", toolInput: { name: "x" }, status: "completed" },
    { type: "tool_result", toolCallId: "s1-b", toolName: "load_skill", result: { skill: "x", loaded: true }, isError: false },
  ];

  it("are closed when the user stops the turn through the API", async () => {
    const { turn } = await setup();
    await prisma.agentRun.update({ where: { id: turn.run.id }, data: { status: "RUNNING", triggerRunId: "trig_1" } });
    await prisma.message.update({ where: { id: turn.assistantMessage.id }, data: { contentBlocks: running as never } });
    const { as } = await import("../helpers/app.js");
    expect((await as("u1").post(`/api/runs/${turn.run.id}/cancel`)).status).toBe(204);
    const blocks = (await reply(turn.assistantMessage.id)).blocks;
    expect(blocks.map((b) => (b.type === "tool_call" ? `${b.toolName}:${b.status}` : b.type === "tool_result" ? `result:${b.isError ? b.errorMessage : "ok"}` : b.type))).toEqual([
      "text",
      "gpt_image_2:failed",
      "result:Stopped.",
      "load_skill:completed",
      "result:ok",
    ]);
  });

  it("are closed with the reason when the turn fails or is cleaned up, and a completed turn is left as it is", async () => {
    const { finalizeRun } = await import("#src/services/runs.js");
    const failed = await setup();
    await prisma.agentRun.update({ where: { id: failed.turn.run.id }, data: { status: "RUNNING" } });
    await finalizeRun(failed.turn.run.id, { status: "FAILED", errorCode: "AGENT_TIMEOUT", blocks: running as never });
    expect((await reply(failed.turn.assistantMessage.id)).blocks.find((b) => b.type === "tool_result" && b.toolCallId === "s1-a")).toMatchObject({ errorMessage: "Stopped because the turn ended." });

    await resetDb();
    const done = await setup();
    await prisma.agentRun.update({ where: { id: done.turn.run.id }, data: { status: "RUNNING" } });
    await finalizeRun(done.turn.run.id, { status: "COMPLETED", blocks: running as never });
    expect((await reply(done.turn.assistantMessage.id)).blocks.find((b) => b.type === "tool_call" && b.toolCallId === "s1-a")).toMatchObject({ status: "running" });
  });
});

describe("what the tool card shows", () => {
  it("each media tool's result has its link at the top level, matching the shared display contract", async () => {
    const { MediaResultDisplaySchema, TOOL_LABELS } = await import("#src/contracts/index.js");
    const { displayResult } = await import("#src/tools/registry.js");
    const gpt = displayResult(agentTools.get("gpt_image_2")!, { images: [{ url: IMG, width: 1024, height: 1024, mimeType: "image/png" }, { url: CROPPED }] });
    expect(gpt).toEqual({ url: IMG, urls: [IMG, CROPPED], width: 1024, height: 1024, mimeType: "image/png" });
    expect(displayResult(agentTools.get("crop_image")!, { image: { url: CROPPED, width: 1024, height: 512 } })).toEqual({ url: CROPPED, width: 1024, height: 512 });
    expect(displayResult(agentTools.get("merge_videos")!, { video: { url: "https://a.test/v.mp4", mimeType: "video/mp4", durationMs: 20_022 } })).toEqual({ url: "https://a.test/v.mp4", mimeType: "video/mp4", durationMs: 20_022 });
    for (const result of [gpt]) expect(MediaResultDisplaySchema.safeParse(result).success).toBe(true);
    expect(Object.keys(TOOL_LABELS).sort()).toEqual([...agentTools.names()].sort()); // every tool has a label
  });

  it("streams the display form in tool-end, while the model reads the full result", async () => {
    const server = await magica([completed("crop")]);
    const { payload } = await setup({ question: `Crop ${IMG}` });
    const { emitted, model } = await run(payload, [[toolCall("crop_image", { image_url: IMG, crop: { x: 0, y: 0, width: 100, height: 50 } }, "Display01"), finished()], [text("ok"), finished()]], { magicaUrl: server.url });
    expect(emitted.find((c) => c.type === "tool-end")).toMatchObject({ status: "completed", creditCost: CROP_COST, result: { url: CROPPED, width: 1024, height: 512 } });
    expect(JSON.parse((model.calls[1]?.messages.at(-1) as { content: string }).content)).toEqual({ image: { url: CROPPED, width: 1024, height: 512 } });
  });
});

describe("thinking time and media placeholders", () => {
  it("measures only the model's first thinking, not the tool that runs after it", async () => {
    const server = await magica([completed("gpt_text")]);
    const { turn, payload } = await setup({ question: "Draw a fox" });
    let clock = 1_000_000;
    const model = fakeModelSteps([
      [{ type: "reasoning", delta: "Let me draw it." }, { then: () => void (clock += 2_000) }, toolCall("gpt_image_2", { mode: "text", prompt: "A fox" }, "ThinkTime"), finished()],
      [text("Here it is."), finished()],
    ]);
    const magicaClock = fakeClockClient(server.url);
    await runAgentTurn(payload, {
      stream: model.stream,
      emit: () => undefined,
      setStatus: () => undefined,
      triggerRunId: "t",
      signal: new AbortController().signal,
      flushEveryMs: 0,
      now: () => clock,
      tools: {
        registry: agentTools,
        skills,
        runMagicaCalls: async (calls) => {
          clock += 65_000; // the image takes over a minute
          return Promise.all(calls.map((c) => runMagicaInvocation(c.invocationId, { client: magicaClock.client, now: magicaClock.now, registry: agentTools, log: silent })));
        },
      },
    });
    const thinking = (await reply(turn.assistantMessage.id)).blocks.find((b) => b.type === "thinking");
    expect(thinking).toMatchObject({ durationMs: 2_000 });
  });

  it("removes [Generated …] lines a model copies into its answer, keeping the rest of the text", async () => {
    const server = await magica([completed("gpt_text")]);
    const { turn, payload } = await setup({ question: "Draw a fox" });
    await run(payload, [[toolCall("gpt_image_2", { mode: "text", prompt: "A fox" }, "Echo00001"), finished()], [text(`Here is your fox.\n[Generated image: ${IMG}]\n\nEnjoy! [Generated video: https://a.test/v.mp4]`), finished()]], { magicaUrl: server.url });
    const saved = await reply(turn.assistantMessage.id);
    expect(saved.content).toBe("Here is your fox.\n\nEnjoy!");
    expect(saved.blocks.filter((b) => b.type === "text").map((b) => b.type === "text" && b.content).join("")).not.toContain("[Generated");
    expect(saved.blocks.some((b) => b.type === "image" && b.url === IMG)).toBe(true); // the real media stays
  });

  it("removes copied [Attached …] lines too, including the expired form", async () => {
    const server = await magica([completed("gpt_text")]);
    const { turn, payload } = await setup({ question: "Draw a fox" });
    await run(payload, [[toolCall("gpt_image_2", { mode: "text", prompt: "A fox" }, "Echo00003"), finished()], [text(`Cropped it.\n[Attached image: ${IMG}]\nThe other one: [Attached video (expired)] is gone.`), finished()]], { magicaUrl: server.url });
    const saved = await reply(turn.assistantMessage.id);
    expect(saved.content).toBe("Cropped it.\n\nThe other one: is gone.");
    expect(saved.content).not.toContain("[Attached");
  });

  it("drops a text block that was only a placeholder", async () => {
    const server = await magica([completed("gpt_text")]);
    const { turn, payload } = await setup({ question: "Draw a fox" });
    await run(payload, [[toolCall("gpt_image_2", { mode: "text", prompt: "A fox" }, "Echo00002"), finished()], [text(`[Generated image: ${IMG}]`), finished()]], { magicaUrl: server.url });
    expect((await reply(turn.assistantMessage.id)).blocks.some((b) => b.type === "text")).toBe(false);
  });

  it("tells the model not to write those lines", async () => {
    const { systemPrompt } = await import("#src/agent/prompt.js");
    const prompt = systemPrompt(new Date(0), { skills, tools: agentTools.functions().map((f) => ({ name: f.function.name, description: f.function.description })) });
    expect(prompt).toMatch(/Never write those \[Generated …\], \[Attached …\] or \[Plan …\] lines in your reply/);
  });
});
