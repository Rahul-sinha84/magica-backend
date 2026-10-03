import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { V1ErrorResponseSchema, V1ToolRunAcceptedSchema, V1ToolRunResponseSchema } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { createApiKey } from "#src/services/apiKeys.js";
import { QUEUE_LIMIT_MS, TOOL_CALL_LIMIT_MS } from "#src/services/reconcile.js";
import { endInvocation } from "#src/services/toolInvocations.js";
import { gptImage2Estimate } from "#src/tools/costs.js";
import { agentTools } from "#src/tools/index.js";
import { runMagicaInvocation } from "#src/tools/magicaInvocation.js";
import { app } from "../helpers/app.js";
import { fixtures, resetDb } from "../helpers/db.js";
import { api } from "../helpers/http.js";
import { fakeClockClient, fixture, startMagicaServer, type Reply } from "../helpers/magicaServer.js";
import { trigger } from "../helpers/triggerMock.js";

beforeEach(resetDb);
const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const silent = pino({ level: "silent" });
const IMAGE = gptImage2Estimate({ quality: "low", size: "auto", n: 1 }); // held while it runs: Magica's price for a low-quality image
const IMAGE_COST = 7644; // what the fixture's Magica run reports it used: what the run is charged
const GENERATED = "https://g.tlcdn.com/gen/851fbf5cbc7546dcb9d22966b915153c.png"; // what the gpt_text fixture returns

async function keyFor(userId: string, balance = 10_000_000) {
  await fixtures.user({ id: userId, balance });
  return (await createApiKey(userId, { label: "tools", perMinute: 1000, perDay: 10_000 })).secret;
}
const start = (secret: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  let req = api(app).post(`/v1/tools/${path}`).set("x-api-key", secret).send(body as object);
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return req;
};
const getRun = async (secret: string, runId: string) => {
  const res = await api(app).get(`/v1/tools/runs/${runId}`).set("x-api-key", secret);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return V1ToolRunResponseSchema.parse(res.body).run;
};
const credits = (userId: string) => prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true, held: true } });

/** What the magica-tool task does with a dispatched standalone run, against a fake Magica. */
async function work(invocationId: string, polls: Reply[] = [{ status: 200, json: fixture("run.gpt_text.completed.json") }]) {
  const server = await startMagicaServer({
    "POST /v1/nodes/*/run": [{ status: 202, json: { runId: "mg_standalone" } }],
    "GET /v1/nodes/runs/*": polls,
    "GET /v1/models/gpt-image-2-text/schema": [{ status: 200, json: fixture("schema.gpt-image-2-text.json") }],
  });
  servers.push(server);
  const clock = fakeClockClient(server.url);
  return runMagicaInvocation(invocationId, { client: clock.client, now: clock.now, registry: agentTools, log: silent, signal: new AbortController().signal });
}

describe("POST /v1/tools/{tool}", () => {
  it("records the run without a chat, reserves its credits and starts the durable task", async () => {
    const secret = await keyFor("u1");
    const res = await start(secret, "gpt-image-2", { mode: "text", prompt: "A fox", quality: "low" });
    expect(res.status).toBe(202);
    const { runId } = V1ToolRunAcceptedSchema.parse(res.body);
    expect(await prisma.toolInvocation.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ userId: "u1", agentRunId: null, toolCallId: "api", toolName: "gpt_image_2", status: "PENDING", input: { mode: "text", prompt: "A fox", quality: "low", n: 1, size: "auto" } });
    expect(await credits("u1")).toEqual({ balance: 10_000_000, held: IMAGE });
    expect(trigger.toolDispatches).toEqual([{ payload: { invocationId: runId, userId: "u1", traceId: res.headers["x-trace-id"] as string }, key: `tool:api:${runId}`, triggerRunId: expect.any(String) as unknown }]);
    expect(JSON.stringify(res.body)).not.toContain(trigger.toolDispatches[0]!.triggerRunId);
  });

  it("settles a completed run exactly once: charged, its image in the library, and shown with the result", async () => {
    const secret = await keyFor("u1");
    const { runId } = V1ToolRunAcceptedSchema.parse((await start(secret, "gpt-image-2", { mode: "text", prompt: "A fox" })).body);
    // a duplicated task at the same moment: one does the work, the other stands down without touching the call
    const outcomes = await Promise.all([work(runId), work(runId)]);
    expect(outcomes.map((o) => (o.status === "COMPLETED" ? "COMPLETED" : o.message)).sort()).toEqual(["COMPLETED", "This tool call is already running."]);
    expect((await work(runId)).status).toBe("COMPLETED"); // a later repeat answers from the database
    expect(await credits("u1")).toEqual({ balance: 10_000_000 - IMAGE_COST, held: 0 });
    expect(await prisma.creditLedger.count({ where: { type: "CHARGE" } })).toBe(1);
    expect(await prisma.mediaAsset.findMany({ select: { userId: true, url: true, source: true } })).toEqual([{ userId: "u1", url: GENERATED, source: "GENERATED" }]);

    const run = await getRun(secret, runId);
    expect(run).toMatchObject({ id: runId, tool: "gpt_image_2", status: "completed", credits: IMAGE_COST, error: null, assets: [{ type: "image", url: GENERATED }] });
    expect(JSON.stringify(run)).not.toContain("mg_standalone");
  });

  it("gives the credits back when the run fails, with the reason", async () => {
    const secret = await keyFor("u1");
    const { runId } = V1ToolRunAcceptedSchema.parse((await start(secret, "gpt-image-2", { mode: "text", prompt: "A fox" })).body);
    await work(runId, [{ status: 200, json: fixture("run.gpt_text.failed.json") }]);
    expect(await getRun(secret, runId)).toMatchObject({ status: "failed", credits: 0, error: expect.any(String) as unknown, assets: [] });
    expect(await credits("u1")).toEqual({ balance: 10_000_000, held: 0 });
  });

  it("gives the credits back when the task dies (its failure hook ends the run)", async () => {
    const secret = await keyFor("u1");
    const { runId } = V1ToolRunAcceptedSchema.parse((await start(secret, "crop-image", { image_url: GENERATED, crop: { x: 0, y: 0, width: 100, height: 50 } })).body);
    await endInvocation(runId, "FAILED", "The tool stopped unexpectedly, so nothing was charged. Please try again.");
    expect(await getRun(secret, runId)).toMatchObject({ status: "failed", error: "The tool stopped unexpectedly, so nothing was charged. Please try again." });
    expect(await credits("u1")).toEqual({ balance: 10_000_000, held: 0 });
  });

  it("gives the same run for a repeated Idempotency-Key, reserving once", async () => {
    const secret = await keyFor("u1");
    const body = { mode: "text", prompt: "A fox" };
    const first = await start(secret, "gpt-image-2", body, { "Idempotency-Key": "fox-1" });
    const again = await start(secret, "gpt-image-2", body, { "Idempotency-Key": "fox-1" });
    expect(again.body).toEqual(first.body);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(await prisma.toolInvocation.count()).toBe(1);
    expect(await credits("u1")).toEqual({ balance: 10_000_000, held: 68_484 }); // once, at the default quality's price (medium)
    // the same key on another tool is a different request
    expect((await start(secret, "crop-image", { image_url: GENERATED, crop: { x: 0, y: 0, width: 50, height: 50 } }, { "Idempotency-Key": "fox-1" })).status).toBe(202);
  });

  it.each([
    ["edit mode without an image", "gpt-image-2", { mode: "edit", prompt: "Make it red" }],
    ["an http (not https) image", "crop-image", { image_url: "http://insecure.test/a.png", crop: { x: 0, y: 0, width: 50, height: 50 } }],
    ["a crop over 100%", "crop-image", { image_url: GENERATED, crop: { x: 60, y: 0, width: 50, height: 50 } }],
    ["one video to merge", "merge-videos", { video_urls: ["https://a.test/1.mp4"] }],
    ["no body", "gpt-image-2", undefined],
  ])("refuses %s with the agent's own validation (400), recording and charging nothing", async (_label, path, body) => {
    const secret = await keyFor("u1");
    const res = await start(secret, path, body);
    expect(res.status).toBe(400);
    expect(V1ErrorResponseSchema.parse(res.body).code).toBe("VALIDATION_FAILED");
    expect(await prisma.toolInvocation.count()).toBe(0);
    expect(await credits("u1")).toEqual({ balance: 10_000_000, held: 0 });
  });

  it("answers 404 for a tool that doesn't exist (including names every object has)", async () => {
    const secret = await keyFor("u1");
    for (const path of ["delete-everything", "constructor", "toString", "gpt_image_2"]) {
      const res = await start(secret, path, {});
      expect(res.status, path).toBe(404);
      expect(V1ErrorResponseSchema.parse(res.body).error).toMatch(/^There is no tool/);
    }
  });

  it("refuses a run the user can't pay for (402), recording nothing", async () => {
    const secret = await keyFor("u1", IMAGE - 1); // just short of the image's estimate
    const res = await start(secret, "gpt-image-2", { mode: "text", prompt: "A fox" });
    expect(res.status).toBe(402);
    expect(await prisma.toolInvocation.count()).toBe(0);
    expect(trigger.toolDispatches).toEqual([]);
  });

  it("gives the credits back when the task can't be started (503)", async () => {
    const secret = await keyFor("u1");
    trigger.toolDispatchError = new Error("Trigger.dev is down");
    const res = await start(secret, "gpt-image-2", { mode: "text", prompt: "A fox" });
    expect(res.status).toBe(503);
    expect(await prisma.toolInvocation.findFirstOrThrow()).toMatchObject({ status: "FAILED" });
    expect(await credits("u1")).toEqual({ balance: 10_000_000, held: 0 });
  });
});

describe("GET /v1/tools/runs/{runId}", () => {
  it("ends a run that never started within the queue's limit, giving the credits back", async () => {
    const secret = await keyFor("u1");
    const { runId } = V1ToolRunAcceptedSchema.parse((await start(secret, "gpt-image-2", { mode: "text", prompt: "A fox" })).body);
    await prisma.toolInvocation.update({ where: { id: runId }, data: { createdAt: new Date(Date.now() - QUEUE_LIMIT_MS - 1000) } });
    expect(await getRun(secret, runId)).toMatchObject({ status: "failed", error: "The tool run couldn't start in time, so nothing was charged. Please try again." });
    expect(await credits("u1")).toEqual({ balance: 10_000_000, held: 0 });
  });

  it("ends a run that has been running past the tool's limit, but leaves a recent one alone", async () => {
    const secret = await keyFor("u1");
    const { runId } = V1ToolRunAcceptedSchema.parse((await start(secret, "gpt-image-2", { mode: "text", prompt: "A fox" })).body);
    await prisma.toolInvocation.update({ where: { id: runId }, data: { status: "RUNNING", dispatchedAt: new Date(Date.now() - 60_000) } });
    expect(await getRun(secret, runId)).toMatchObject({ status: "running" });
    await prisma.toolInvocation.update({ where: { id: runId }, data: { dispatchedAt: new Date(Date.now() - TOOL_CALL_LIMIT_MS - 1000) } });
    expect(await getRun(secret, runId)).toMatchObject({ status: "failed", error: "The tool run took too long, so nothing was charged. Please try again." });
    expect(await credits("u1")).toEqual({ balance: 10_000_000, held: 0 });
  });

  it("is the owner's alone", async () => {
    const mine = await keyFor("u1");
    const theirs = await keyFor("u2");
    const { runId } = V1ToolRunAcceptedSchema.parse((await start(theirs, "gpt-image-2", { mode: "text", prompt: "A fox" })).body);
    for (const id of [runId, "cmnotarun0000000000000", "not a run!"]) expect((await api(app).get(`/v1/tools/runs/${id}`).set("x-api-key", mine)).status, id).toBe(404);
  });
});
