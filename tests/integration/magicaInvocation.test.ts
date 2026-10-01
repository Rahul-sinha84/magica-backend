import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "#src/db/client.js";
import { createInvocation, endInvocation, markDispatching, markRunning } from "#src/services/toolInvocations.js";
import { agentTools } from "#src/tools/index.js";
import { runMagicaInvocation } from "#src/tools/magicaInvocation.js";
import { cropFields } from "#src/tools/magicaTools.js";
import { fixtures, resetDb } from "../helpers/db.js";
import { fakeClockClient, fixture, startMagicaServer, TEST_KEY, type Reply } from "../helpers/magicaServer.js";

beforeEach(resetDb);
const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  vi.restoreAllMocks();
});

const IMG = "https://g.tlcdn.com/gen/851fbf5cbc7546dcb9d22966b915153c.png";
const START = "POST /v1/nodes/*/run";
const POLL = "GET /v1/nodes/runs/*";
const SCHEMA = "GET /v1/models/*/schema";
const silent = pino({ level: "silent" });

const schemaFor = (path: string): Reply => {
  const id = path.split("/")[3] ?? "";
  return { status: 200, json: fixture(`schema.${id}.json`) };
};
/** A fake Magica that knows the real schemas and answers the given run statuses. */
async function magicaFor(polls: Reply[], start: Reply[] = [{ status: 202, json: { runId: "mg_run_1" } }]) {
  const server = await startMagicaServer({
    [START]: start,
    [POLL]: polls,
    "GET /v1/models/gpt-image-2-text/schema": [schemaFor("/v1/models/gpt-image-2-text/schema")],
    "GET /v1/models/gpt-image-2-edit/schema": [schemaFor("/v1/models/gpt-image-2-edit/schema")],
    "GET /v1/models/crop_image/schema": [schemaFor("/v1/models/crop_image/schema")],
    "GET /v1/models/merge_videos/schema": [schemaFor("/v1/models/merge_videos/schema")],
  });
  servers.push(server);
  return server;
}
const completed = (name: string): Reply => ({ status: 200, json: fixture(`run.${name}.completed.json`) });
const status = (name: string, value: string): Reply => ({ status: 200, json: { ...fixture<Record<string, unknown>>(`run.${name}.running.json`), status: value } });

async function setup(toolName: string, rawInput: unknown, balance = 10_000_000) {
  const user = await fixtures.user({ balance });
  const chat = await fixtures.chat(user.id);
  const run = await fixtures.run(chat.id, user.id, "RUNNING");
  const tool = agentTools.get(toolName);
  const input = tool?.input.parse(rawInput);
  const invocation = await createInvocation({ agentRunId: run.id, userId: user.id, toolCallId: "call_1", toolName, input, creditCost: tool?.creditCost ?? 0 });
  return { user, run, invocation };
}
const invoke = (invocationId: string, url: string, extra: Partial<Parameters<typeof runMagicaInvocation>[1]> = {}) => {
  const clock = fakeClockClient(url); // the executor and the client share one fake clock
  return runMagicaInvocation(invocationId, { client: clock.client, now: clock.now, registry: agentTools, log: silent, ...extra });
};
const row = (id: string) => prisma.toolInvocation.findUniqueOrThrow({ where: { id } });
const credits = async (id: string) => prisma.user.findUniqueOrThrow({ where: { id }, select: { balance: true, held: true } });

describe("each tool, end to end against Magica", () => {
  it("gpt_image_2 text: runs the text model with the input in Magica's exact form, saves the image and charges once", async () => {
    const server = await magicaFor([status("gpt_text", "QUEUED"), status("gpt_text", "RUNNING"), completed("gpt_text")]);
    const { user, invocation } = await setup("gpt_image_2", { mode: "text", prompt: "A red fox in snow", quality: "low", size: "1024x1024" });
    const outcome = await invoke(invocation.id, server.url);

    const sent = server.requests.find((r) => r.method === "POST");
    expect(sent).toMatchObject({ path: "/v1/nodes/gpt_image_2/run", body: { subModelId: "gpt-image-2-text", input: { prompt: "A red fox in snow", size: "1024x1024", quality: "Low", background: "Auto", n: 1, output_format: "PNG" } } });
    expect(outcome).toEqual({
      status: "COMPLETED",
      output: { images: [{ url: "https://g.tlcdn.com/gen/851fbf5cbc7546dcb9d22966b915153c.png", width: 1024, height: 1024, mimeType: "image/png" }] },
      assets: [{ type: "image", url: "https://g.tlcdn.com/gen/851fbf5cbc7546dcb9d22966b915153c.png", model: "GPT Image 2", prompt: "A red fox in snow", mimeType: "image/png", width: 1024, height: 1024 }],
      durationMs: 9_000,
    });
    expect(await row(invocation.id)).toMatchObject({ status: "COMPLETED", magicaRunId: "mg_run_1", creditCost: 1_000_000, providerCost: 7644, durationMs: 9_000 });
    expect(await credits(user.id)).toEqual({ balance: 9_000_000, held: 0 });
  });

  it("gpt_image_2 edit: runs the edit model with the images as uploadedImages", async () => {
    const server = await magicaFor([completed("gpt_edit")]);
    const { invocation } = await setup("gpt_image_2", { mode: "edit", prompt: "Make it night", image_urls: [IMG] });
    expect(await invoke(invocation.id, server.url)).toMatchObject({ status: "COMPLETED", output: { images: [{ url: expect.stringContaining("047cfe73") as unknown }] } });
    expect(server.requests.find((r) => r.method === "POST")?.body).toMatchObject({ subModelId: "gpt-image-2-edit", input: { prompt: "Make it night", uploadedImages: [IMG], quality: "Medium" } });
    expect(server.requests.some((r) => r.path === "/v1/models/gpt-image-2-edit/schema")).toBe(true);
  });

  it("crop_image: sends the rectangle in Magica's percent fields and saves the cropped image", async () => {
    const server = await magicaFor([completed("crop")]);
    const { user, invocation } = await setup("crop_image", { image_url: IMG, crop: { x: 0, y: 0, width: 100, height: 50 } });
    expect(await invoke(invocation.id, server.url)).toMatchObject({ status: "COMPLETED", output: { image: { url: expect.stringContaining("7a3cc3bb") as unknown, width: 1024, height: 512 } }, assets: [{ type: "image", model: "Crop Image", width: 1024, height: 512 }] });
    expect(server.requests.find((r) => r.method === "POST")?.body).toEqual({ input: { image_url: IMG, x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 50 } });
    expect(await credits(user.id)).toEqual({ balance: 9_800_000, held: 0 });
  });

  it("merge_videos: keeps the order, sends the transition and saves the video with its duration", async () => {
    const server = await magicaFor([completed("merge")]);
    const urls = ["https://a.test/2.mp4", "https://a.test/1.mp4", "https://a.test/3.mp4"];
    const { invocation } = await setup("merge_videos", { video_urls: urls, transition: "fade" });
    expect(await invoke(invocation.id, server.url)).toMatchObject({ status: "COMPLETED", output: { video: { mimeType: "video/mp4", durationMs: 20_022, width: 640, height: 360 } }, assets: [{ type: "video", model: "Merge Videos", mimeType: "video/mp4" }] });
    expect(server.requests.find((r) => r.method === "POST")?.body).toEqual({ input: { video_urls: urls, transition: "fade" } });
  });
});

describe("crop forms in Magica's fields", () => {
  it("maps each of the three forms", () => {
    expect(cropFields({ image_url: IMG, crop: { x: 1, y: 2, width: 3, height: 4, unit: "percent" } })).toEqual({ x_percent: 1, y_percent: 2, width_percent: 3, height_percent: 4 });
    expect(cropFields({ image_url: IMG, crop: { x: 10, y: 20, width: 300, height: 200, unit: "pixel" } })).toEqual({ x_px: 10, y_px: 20, width_px: 300, height_px: 200 });
    expect(cropFields({ image_url: IMG, x_percent: 0, y_percent: 50, width_percent: 100, height_percent: 50 })).toEqual({ x_percent: 0, y_percent: 50, width_percent: 100, height_percent: 50 });
    expect(cropFields({ image_url: IMG, width_px: 512, height_px: 512 })).toEqual({ x_px: undefined, y_px: undefined, width_px: 512, height_px: 512 });
  });

  it("sends a centred pixel crop without x/y", async () => {
    const server = await magicaFor([completed("crop")]);
    const { invocation } = await setup("crop_image", { image_url: IMG, width_px: 512, height_px: 512 });
    await invoke(invocation.id, server.url);
    expect(server.requests.find((r) => r.method === "POST")?.body).toEqual({ input: { image_url: IMG, width_px: 512, height_px: 512 } });
  });
});

describe("failures release the credits and save a safe reason", () => {
  it.each([
    ["a wrong key (401)", [{ status: 401, json: fixture("error.401.json") }], "Authentication error with the media service."],
    ["Magica out of credits (403)", [{ status: 403 }], "The media service is unavailable right now."],
    ["rate limited twice (429)", [{ status: 429, headers: { "Retry-After": "1" } }], "The media service is busy, please try again."],
    ["a rejected input (400)", [{ status: 400, json: { error: "Invalid media URL" } }], "The media service couldn't use that input. Make sure the links are public images or videos."],
  ])("on start: %s", async (_label, start, message) => {
    const server = await magicaFor([completed("gpt_text")], start);
    const { user, invocation } = await setup("gpt_image_2", { mode: "text", prompt: "A fox" });
    expect(await invoke(invocation.id, server.url)).toEqual({ status: "FAILED", message });
    expect(await row(invocation.id)).toMatchObject({ status: "FAILED", errorMessage: message, creditCost: 0 });
    expect(await credits(user.id)).toEqual({ balance: 10_000_000, held: 0 });
  });

  it("a run that fails at Magica, with Magica's own message", async () => {
    const server = await magicaFor([status("gpt_text", "RUNNING"), { status: 200, json: fixture("run.gpt_text.failed.json") }]);
    const { user, invocation } = await setup("gpt_image_2", { mode: "text", prompt: "A fox" });
    expect(await invoke(invocation.id, server.url)).toEqual({ status: "FAILED", message: "The image could not be generated. Please try a different prompt." });
    expect(await credits(user.id)).toEqual({ balance: 10_000_000, held: 0 });
  });

  it("a run that never finishes: timed out", async () => {
    const server = await magicaFor([status("crop", "RUNNING")]);
    const { invocation } = await setup("crop_image", { image_url: IMG, crop: { x: 0, y: 0, width: 50, height: 50 } });
    expect(await invoke(invocation.id, server.url, { maxWaitMs: 60_000 })).toEqual({ status: "FAILED", message: "Cropping timed out." });
  });

  it("a finished run with no usable result: failed, not charged", async () => {
    const server = await magicaFor([{ status: 200, json: { ...fixture<Record<string, unknown>>("run.merge.completed.json"), output: { fps: 30 } } }]);
    const { user, invocation } = await setup("merge_videos", { video_urls: ["https://a.test/1.mp4", "https://a.test/2.mp4"] });
    expect(await invoke(invocation.id, server.url)).toEqual({ status: "FAILED", message: "Video merging finished but returned no result." });
    expect(await credits(user.id)).toEqual({ balance: 10_000_000, held: 0 });
  });

  it("input the model's live schema no longer accepts: failed before anything is sent", async () => {
    const server = await magicaFor([completed("gpt_text")]);
    const { invocation } = await setup("gpt_image_2", { mode: "text", prompt: "A fox" });
    await prisma.toolInvocation.update({ where: { id: invocation.id }, data: { input: { mode: "text", prompt: "A fox", size: "auto", quality: "medium", background: "auto", n: 1, output_format: "png", extra: 1 } } });
    // a schema that dropped "Medium" quality
    servers.push(server);
    const changed = await startMagicaServer({ [SCHEMA]: [{ status: 200, json: { ...fixture<Record<string, unknown>>("schema.gpt-image-2-text.json"), fields: (fixture<{ fields: { name: string; options?: unknown[] }[] }>("schema.gpt-image-2-text.json").fields).map((f) => (f.name === "quality" ? { ...f, options: ["High", "Low"] } : f)) } }], [START]: [{ status: 202, json: { runId: "x" } }] });
    servers.push(changed);
    const outcome = await invoke(invocation.id, changed.url);
    expect(outcome).toEqual({ status: "FAILED", message: "The media service doesn't accept this input: quality must be one of High, Low." });
    expect(changed.count("POST")).toBe(0);
    expect((await row(invocation.id)).dispatchedAt).toBeNull();
  });
});

describe("never paying twice", () => {
  it("a start whose outcome is unknown (500) is never resent, and nothing is charged", async () => {
    const server = await magicaFor([completed("gpt_text")], [{ status: 500 }, { status: 202, json: { runId: "second" } }]);
    const { user, invocation } = await setup("gpt_image_2", { mode: "text", prompt: "A fox" });
    expect(await invoke(invocation.id, server.url)).toEqual({ status: "FAILED", message: "We couldn't confirm whether this finished, so nothing was charged. Please try again." });
    expect(server.count("POST")).toBe(1);
    expect(await row(invocation.id)).toMatchObject({ status: "FAILED", magicaRunId: null });
    expect((await row(invocation.id)).dispatchedAt).toBeInstanceOf(Date);
    expect(await credits(user.id)).toEqual({ balance: 10_000_000, held: 0 });
  });

  it("a call that was sent but whose run id was never saved (the worker died) is not sent again", async () => {
    const server = await magicaFor([completed("gpt_text")]);
    const { user, invocation } = await setup("gpt_image_2", { mode: "text", prompt: "A fox" });
    await markDispatching(invocation.id);
    expect(await invoke(invocation.id, server.url)).toMatchObject({ status: "FAILED", message: expect.stringMatching(/couldn't confirm/) as unknown });
    expect(server.count("POST")).toBe(0);
    expect(await credits(user.id)).toEqual({ balance: 10_000_000, held: 0 });
  });

  it("a call whose run was started resumes waiting for that run, without starting another", async () => {
    const server = await magicaFor([status("gpt_text", "RUNNING"), completed("gpt_text")]);
    const { user, invocation } = await setup("gpt_image_2", { mode: "text", prompt: "A fox" });
    await markDispatching(invocation.id);
    await markRunning(invocation.id, "mg_existing");
    expect(await invoke(invocation.id, server.url)).toMatchObject({ status: "COMPLETED" });
    expect(server.count("POST")).toBe(0);
    expect(server.requests.filter((r) => r.method === "GET" && r.path.startsWith("/v1/nodes/runs/")).every((r) => r.path === "/v1/nodes/runs/mg_existing")).toBe(true);
    expect(await credits(user.id)).toEqual({ balance: 9_000_000, held: 0 });
  });

  it("a call that already finished answers from what was saved, without calling Magica", async () => {
    const server = await magicaFor([completed("crop")]);
    const { user, invocation } = await setup("crop_image", { image_url: IMG, crop: { x: 0, y: 0, width: 100, height: 50 } });
    const first = await invoke(invocation.id, server.url);
    const requests = server.requests.length;
    expect(await invoke(invocation.id, server.url)).toEqual(first);
    expect(server.requests.length).toBe(requests);
    expect(await credits(user.id)).toEqual({ balance: 9_800_000, held: 0 });
  });

  it("two attempts running the same call at once: one sends it, one charge", async () => {
    const server = await magicaFor([status("crop", "RUNNING"), completed("crop")]);
    const { user, invocation } = await setup("crop_image", { image_url: IMG, crop: { x: 0, y: 0, width: 100, height: 50 } });
    const outcomes = await Promise.all([invoke(invocation.id, server.url), invoke(invocation.id, server.url)]);
    expect(server.count("POST")).toBe(1);
    expect(outcomes.filter((o) => o.status === "COMPLETED")).toHaveLength(1);
    expect(await credits(user.id)).toEqual({ balance: 9_800_000, held: 0 });
  });

  it("keeps the run id safe when saving it fails at first, and still finishes", async () => {
    const server = await magicaFor([status("gpt_text", "RUNNING"), completed("gpt_text")]);
    const { invocation } = await setup("gpt_image_2", { mode: "text", prompt: "A fox" });
    const updateMany = prisma.toolInvocation.updateMany.bind(prisma.toolInvocation);
    let failures = 0;
    vi.spyOn(prisma.toolInvocation, "updateMany").mockImplementation(((args: Parameters<typeof updateMany>[0]) => {
      if ((args.data as { magicaRunId?: string }).magicaRunId && failures++ < 1) return Promise.reject(new Error("database blip"));
      return updateMany(args);
    }) as never);
    expect(await invoke(invocation.id, server.url)).toMatchObject({ status: "COMPLETED" });
    expect(await row(invocation.id)).toMatchObject({ magicaRunId: "mg_run_1", status: "COMPLETED" });
  });
});

describe("stopping", () => {
  it("a call stopped while waiting ends as cancelled and charges nothing", async () => {
    const server = await magicaFor([status("gpt_text", "RUNNING")]);
    const { user, invocation } = await setup("gpt_image_2", { mode: "text", prompt: "A fox" });
    const controller = new AbortController();
    const { client } = fakeClockClient(server.url);
    const outcome = await runMagicaInvocation(invocation.id, {
      client: { ...client, waitForRun: (id, options) => client.waitForRun(id, { ...options, onStatus: () => controller.abort(new DOMException("stop", "AbortError")) }) },
      registry: agentTools,
      log: silent,
      signal: controller.signal,
    });
    expect(outcome).toEqual({ status: "CANCELLED", message: "Stopped." });
    expect(await credits(user.id)).toEqual({ balance: 10_000_000, held: 0 });
  });

  it("a call whose run was stopped elsewhere while it finished is not charged and its result is not used", async () => {
    const server = await magicaFor([completed("gpt_text")]);
    const { user, invocation } = await setup("gpt_image_2", { mode: "text", prompt: "A fox" });
    const { client } = fakeClockClient(server.url);
    const outcome = await runMagicaInvocation(invocation.id, {
      client: { ...client, waitForRun: async (id, options) => { const run = await client.waitForRun(id, options); await endInvocation(invocation.id, "CANCELLED", "Stopped."); return run; } },
      registry: agentTools,
      log: silent,
    });
    expect(outcome).toEqual({ status: "CANCELLED", message: "Stopped." });
    expect(await credits(user.id)).toEqual({ balance: 10_000_000, held: 0 });
  });

  it("a call whose chat was deleted reports that, without crashing", async () => {
    const server = await magicaFor([completed("gpt_text")]);
    const { run, invocation } = await setup("gpt_image_2", { mode: "text", prompt: "A fox" });
    await prisma.chat.delete({ where: { id: run.chatId } });
    expect(await invoke(invocation.id, server.url)).toEqual({ status: "FAILED", message: "This tool call no longer exists." });
    expect(server.requests).toHaveLength(0);
  });
});

describe("secrets", () => {
  it("are never stored on the tool call", async () => {
    const server = await magicaFor([completed("gpt_text")], [{ status: 401, json: fixture("error.401.json") }]);
    const { invocation } = await setup("gpt_image_2", { mode: "text", prompt: "A fox" });
    await invoke(invocation.id, server.url);
    expect(JSON.stringify(await row(invocation.id))).not.toContain(TEST_KEY);
  });
});

describe("the registry", () => {
  it("now offers all five tools, and refuses to run a media tool inline", async () => {
    expect(agentTools.names()).toEqual(["load_skill", "read_skill_asset", "gpt_image_2", "crop_image", "merge_videos"]);
    for (const name of ["gpt_image_2", "crop_image", "merge_videos"]) expect(agentTools.get(name)).toMatchObject({ kind: "magica" });
    const result = await agentTools.execute("crop_image", { image_url: IMG, crop: { x: 0, y: 0, width: 10, height: 10 } }, { agentRunId: "r", chatId: "c", userId: "u", log: silent, signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: false, code: "TOOL_FAILED", message: "crop_image runs as a background task and can't be run inline." });
  });

  it("reports a completed, charged call as completed when the save committed but its reply was lost", async () => {
    const server = await magicaFor([completed("crop")]);
    const { user, invocation } = await setup("crop_image", { image_url: IMG, crop: { x: 0, y: 0, width: 100, height: 50 } });
    const real = prisma.$transaction.bind(prisma) as (fn: unknown) => Promise<unknown>;
    let first = true;
    vi.spyOn(prisma, "$transaction").mockImplementation((async (fn: unknown) => {
      const result = await real(fn); // the save really commits...
      if (first) {
        first = false;
        throw new Error("connection reset"); // ...and then the reply is lost
      }
      return result;
    }));
    const outcome = await invoke(invocation.id, server.url);
    expect(outcome).toMatchObject({ status: "COMPLETED", assets: [{ type: "image", model: "Crop Image" }] });
    expect(await credits(user.id)).toEqual({ balance: 9_800_000, held: 0 }); // charged exactly once
  });

  it("answers a finished call from the database with the same assets, prompt included", async () => {
    const server = await magicaFor([completed("gpt_text")]);
    const { invocation } = await setup("gpt_image_2", { mode: "text", prompt: "A fox in snow" });
    const first = await invoke(invocation.id, server.url);
    const again = await invoke(invocation.id, server.url);
    expect(again).toEqual(first);
    expect(again).toMatchObject({ assets: [{ prompt: "A fox in snow", model: "GPT Image 2" }] });
  });

  it("settles a completion exactly once even if saving it has to be retried", async () => {
    const server = await magicaFor([completed("crop")]);
    const { user, invocation } = await setup("crop_image", { image_url: IMG, crop: { x: 0, y: 0, width: 100, height: 50 } });
    const real = prisma.$transaction.bind(prisma) as (fn: unknown) => Promise<unknown>;
    let calls = 0;
    vi.spyOn(prisma, "$transaction").mockImplementation(((fn: unknown) => (calls++ === 0 ? Promise.reject(new Error("blip")) : real(fn))));
    expect(await invoke(invocation.id, server.url)).toMatchObject({ status: "COMPLETED" });
    expect(await credits(user.id)).toEqual({ balance: 9_800_000, held: 0 });
  });
});
