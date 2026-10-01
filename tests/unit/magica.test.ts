import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createMagicaClient, MAX_RESPONSE_BYTES, MagicaError, MagicaRunSchema, pollDelayMs, resolveInput, retryAfterMs, type ModelSchema } from "#src/lib/magica.js";
import { fakeClockClient, fixture, startMagicaServer, TEST_KEY, type Reply } from "../helpers/magicaServer.js";

const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});
async function magicaWith(routes: Record<string, Reply[]>) {
  const server = await startMagicaServer(routes);
  servers.push(server);
  return server;
}

const RUN_PATH = "/v1/nodes/runs/run_1";
const START = "POST /v1/nodes/*/run";
const POLL = "GET /v1/nodes/runs/*";
const accepted: Reply = { status: 202, json: { runId: "run_1" } };
const run = (status: string, extra: Record<string, unknown> = {}): Reply => ({ status: 200, json: { ...fixture<Record<string, unknown>>("run.gpt_text.completed.json"), id: "run_1", status, ...extra } });

async function failureOf(work: Promise<unknown>): Promise<MagicaError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof MagicaError) return error;
    throw error;
  }
  throw new Error("expected a MagicaError");
}

describe("starting a run", () => {
  it("posts the input to the model's run endpoint with the key and our user agent, and returns the run id", async () => {
    const server = await magicaWith({ [START]: [accepted] });
    const { client } = fakeClockClient(server.url);
    expect(await client.startRun("gpt_image_2", { input: { prompt: "A fox" }, subModelId: "gpt-image-2-text" })).toBe("run_1");
    expect(server.requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/v1/nodes/gpt_image_2/run",
        body: { input: { prompt: "A fox" }, subModelId: "gpt-image-2-text" },
        headers: expect.objectContaining({ authorization: `Bearer ${TEST_KEY}`, "user-agent": "magica-agent-backend/1.0", "content-type": "application/json" }) as unknown,
      }),
    ]);
  });

  it("joins a base URL that has a path and trailing slash correctly, and encodes the model id", async () => {
    const server = await magicaWith({ ["POST /proxy/v1/nodes/*/run"]: [accepted] });
    const { client } = fakeClockClient(`${server.url}/proxy/`);
    await client.startRun("odd/model", { input: {} });
    expect(server.requests[0]?.path).toBe("/proxy/v1/nodes/odd%2Fmodel/run");
  });

  it.each([
    [401, "AUTH", "Authentication error with the media service."],
    [403, "OUT_OF_CREDITS", "The media service is unavailable right now."],
    [400, "INVALID_INPUT", "The media service couldn't use that input. Make sure the links are public images or videos."],
    [404, "MODEL_UNAVAILABLE", "This tool isn't available right now."],
    [410, "MODEL_UNAVAILABLE", "This tool isn't available right now."],
  ])("maps %i to %s with a safe message, posting once", async (status, failure, message) => {
    const server = await magicaWith({ [START]: [{ status, json: fixture("error.401.json") }] });
    const error = await failureOf(fakeClockClient(server.url).client.startRun("gpt_image_2", { input: {} }));
    expect(error).toMatchObject({ failure, message, outcomeUnknown: false, code: "TOOL_FAILED" });
    expect(server.count("POST")).toBe(1);
  });

  it("retries a 429 once, after the Retry-After it was given", async () => {
    const server = await magicaWith({ [START]: [{ status: 429, json: fixture("error.429.json"), headers: { "Retry-After": "7" } }, accepted] });
    const { client, sleeps } = fakeClockClient(server.url);
    expect(await client.startRun("crop_image", { input: {} })).toBe("run_1");
    expect(sleeps).toEqual([7_000]);
    expect(server.count("POST")).toBe(2);
  });

  it("caps a long Retry-After at 30 s, reads it as a date too, and waits 5 s when none is given", async () => {
    const long = await magicaWith({ [START]: [{ status: 429, headers: { "Retry-After": "600" } }, accepted] });
    const a = fakeClockClient(long.url);
    await a.client.startRun("x", { input: {} });
    expect(a.sleeps).toEqual([30_000]);

    const none = await magicaWith({ [START]: [{ status: 429 }, accepted] });
    const b = fakeClockClient(none.url);
    await b.client.startRun("x", { input: {} });
    expect(b.sleeps).toEqual([5_000]);
  });

  it("gives up after the one retry, with the busy message", async () => {
    const server = await magicaWith({ [START]: [{ status: 429, headers: { "Retry-After": "1" } }] });
    const error = await failureOf(fakeClockClient(server.url).client.startRun("x", { input: {} }));
    expect(error).toMatchObject({ failure: "RATE_LIMITED", message: "The media service is busy, please try again.", outcomeUnknown: false });
    expect(server.count("POST")).toBe(2);
  });

  it.each([
    ["a 500", { status: 500, json: { error: "Server error" } }],
    ["a 502 HTML page", { status: 502, text: "<html>Bad gateway</html>" }],
    ["a dropped connection", { close: true }],
  ])("never retries %s on start, and says the outcome is unknown", async (_label, reply) => {
    const server = await magicaWith({ [START]: [reply, accepted] });
    const error = await failureOf(fakeClockClient(server.url).client.startRun("x", { input: {} }));
    expect(error).toMatchObject({ failure: "SERVICE_ERROR", outcomeUnknown: true });
    expect(server.count("POST")).toBe(1);
  });

  it("treats a start that times out as outcome unknown", async () => {
    const server = await magicaWith({ [START]: [{ ...accepted, delayMs: 500 }] });
    const error = await failureOf(fakeClockClient(server.url, { requestTimeoutMs: 50 }).client.startRun("x", { input: {} }));
    expect(error).toMatchObject({ failure: "SERVICE_ERROR", outcomeUnknown: true, message: "The media service couldn't be reached. Please try again." });
    expect(error.detail).toMatch(/timed out after 50 ms/);
  });

  it("treats an accepted start with no run id as outcome unknown", async () => {
    const server = await magicaWith({ [START]: [{ status: 202, json: { ok: true } }] });
    expect(await failureOf(fakeClockClient(server.url).client.startRun("x", { input: {} }))).toMatchObject({ failure: "BAD_RESPONSE", outcomeUnknown: true });
  });

  it("does not follow a redirect (it could send the key elsewhere)", async () => {
    const elsewhere = await magicaWith({ [START]: [accepted] });
    const server = await magicaWith({ [START]: [{ status: 302, headers: { Location: `${elsewhere.url}/v1/nodes/x/run` } }] });
    expect(await failureOf(fakeClockClient(server.url).client.startRun("x", { input: {} }))).toMatchObject({ failure: "SERVICE_ERROR" });
    expect(elsewhere.requests).toHaveLength(0);
  });

  it("treats a run id over 200 characters as unreadable, and as outcome unknown", async () => {
    const server = await magicaWith({ [START]: [{ status: 202, json: { runId: "r".repeat(201) } }] });
    expect(await failureOf(fakeClockClient(server.url).client.startRun("x", { input: {} }))).toMatchObject({ failure: "BAD_RESPONSE", outcomeUnknown: true });
  });

  it("stops when cancelled while the request is in flight, without retrying", async () => {
    const server = await magicaWith({ [START]: [{ ...accepted, delayMs: 2_000 }] });
    const controller = new AbortController();
    const starting = fakeClockClient(server.url).client.startRun("x", { input: {} }, controller.signal);
    setTimeout(() => controller.abort(new DOMException("stopped mid-request", "AbortError")), 50);
    await expect(starting).rejects.toThrow("stopped mid-request");
    expect(server.count("POST")).toBe(1);
  });

  it("stops when cancelled during the wait before its 429 retry, without posting again", async () => {
    const server = await magicaWith({ [START]: [{ status: 429, headers: { "Retry-After": "5" } }, accepted] });
    const controller = new AbortController();
    const client = createMagicaClient({
      baseUrl: server.url,
      apiKey: TEST_KEY,
      sleep: () => {
        controller.abort(new DOMException("stopped while waiting", "AbortError"));
        return Promise.reject(controller.signal.reason as Error);
      },
    });
    await expect(client.startRun("x", { input: {} }, controller.signal)).rejects.toThrow("stopped while waiting");
    expect(server.count("POST")).toBe(1);
  });

  it("does nothing when already cancelled", async () => {
    const server = await magicaWith({ [START]: [accepted] });
    const controller = new AbortController();
    controller.abort(new DOMException("stopped", "AbortError"));
    await expect(fakeClockClient(server.url).client.startRun("x", { input: {} }, controller.signal)).rejects.toThrow("stopped");
    expect(server.requests).toHaveLength(0);
  });
});

describe("waiting for a run", () => {
  it("polls until it completes and returns the completed run, reporting each status", async () => {
    const server = await magicaWith({ [POLL]: [run("QUEUED"), run("RUNNING"), run("COMPLETED")] });
    const { client, sleeps } = fakeClockClient(server.url);
    const seen: string[] = [];
    const done = await client.waitForRun("run_1", { onStatus: (r) => void seen.push(r.status) });
    expect(done).toMatchObject({ status: "COMPLETED", creditUsed: 7644 });
    expect(seen).toEqual(["QUEUED", "RUNNING", "COMPLETED"]);
    expect(sleeps).toEqual([3_000, 3_000, 3_000]);
    expect(server.requests.every((r) => r.path === RUN_PATH && r.headers.authorization === `Bearer ${TEST_KEY}`)).toBe(true);
  });

  it("slows down the longer a run takes, using at most 27 checks over five minutes", async () => {
    const server = await magicaWith({ [POLL]: [run("RUNNING")] });
    const { client, sleeps } = fakeClockClient(server.url);
    await failureOf(client.waitForRun("run_1", { maxWaitMs: 5 * 60_000 }));
    expect(sleeps.slice(0, 9)).toEqual([3_000, 3_000, 3_000, 3_000, 3_000, 5_000, 5_000, 5_000, 10_000]);
    expect(Math.max(...sleeps)).toBe(15_000);
    expect(server.count("GET")).toBeLessThanOrEqual(27); // 5 at 3 s + 3 at 5 s + 3 at 10 s + 16 at 15 s
  });

  it("stops waiting at the deadline with a timed-out message", async () => {
    const server = await magicaWith({ [POLL]: [run("RUNNING")] });
    const error = await failureOf(fakeClockClient(server.url).client.waitForRun("run_1", { maxWaitMs: 60_000, label: "Image generation" }));
    expect(error).toMatchObject({ failure: "TIMED_OUT", message: "Image generation timed out." });
  });

  it("uses Magica's own user-facing message when a run fails, or a plain one when it gives none", async () => {
    const withMessage = await magicaWith({ [POLL]: [{ status: 200, json: fixture("run.gpt_text.failed.json") }] });
    expect(await failureOf(fakeClockClient(withMessage.url).client.waitForRun("run_1"))).toMatchObject({ failure: "FAILED", message: "The image could not be generated. Please try a different prompt." });
    const bare = await magicaWith({ [POLL]: [run("FAILED", { userMessage: null, error: "provider 500" })] });
    const error = await failureOf(fakeClockClient(bare.url).client.waitForRun("run_1", { label: "Video merging" }));
    expect(error).toMatchObject({ failure: "FAILED", message: "Video merging failed." });
    expect(error.detail).toContain("provider 500");
  });

  it("reports a cancelled run", async () => {
    const server = await magicaWith({ [POLL]: [run("CANCELED")] });
    expect(await failureOf(fakeClockClient(server.url).client.waitForRun("run_1", { label: "Cropping" }))).toMatchObject({ failure: "CANCELED", message: "Cropping was cancelled." });
  });

  it("keeps waiting through status-check errors (they are safe to repeat), honouring Retry-After", async () => {
    const server = await magicaWith({ [POLL]: [{ status: 500 }, { status: 429, headers: { "Retry-After": "9" } }, { close: true }, run("COMPLETED")] });
    const { client, sleeps } = fakeClockClient(server.url);
    expect(await client.waitForRun("run_1")).toMatchObject({ status: "COMPLETED" });
    expect(sleeps).toEqual([3_000, 3_000, 9_000, 8_000]);
  });

  it("reports an unknown run as not found, not as an unavailable tool", async () => {
    const server = await magicaWith({ [POLL]: [{ status: 404, json: { error: "Not found" } }] });
    expect(await failureOf(fakeClockClient(server.url).client.getRun("run_1"))).toMatchObject({ failure: "RUN_NOT_FOUND", message: "The media service lost track of this request. Please try again." });
  });

  it("keeps checking a run that isn't visible yet just after it started, then gives up if it never appears", async () => {
    const appears = await magicaWith({ [POLL]: [{ status: 404 }, run("COMPLETED")] });
    expect(await fakeClockClient(appears.url).client.waitForRun("run_1")).toMatchObject({ status: "COMPLETED" });
    const never = await magicaWith({ [POLL]: [{ status: 404 }] });
    expect(await failureOf(fakeClockClient(never.url, { maxPollErrors: 2 }).client.waitForRun("run_1", { maxWaitMs: 60 * 60_000 }))).toMatchObject({ failure: "RUN_NOT_FOUND" });
    expect(never.count("GET")).toBe(3);
  });

  it("keeps waiting when saving progress fails (the run is still going, and still being paid for)", async () => {
    const server = await magicaWith({ [POLL]: [run("RUNNING"), run("RUNNING"), run("COMPLETED")] });
    const errors: unknown[] = [];
    let calls = 0;
    const done = await fakeClockClient(server.url).client.waitForRun("run_1", {
      onStatus: () => {
        calls++;
        if (calls <= 2) throw new Error("database blip");
      },
      onStatusError: (error) => void errors.push(error),
    });
    expect(done.status).toBe("COMPLETED");
    expect(errors).toHaveLength(2);
    expect(calls).toBe(3);
  });

  it("keeps waiting when saving progress fails asynchronously, even with no error handler", async () => {
    const server = await magicaWith({ [POLL]: [run("RUNNING"), run("COMPLETED")] });
    const done = await fakeClockClient(server.url).client.waitForRun("run_1", { onStatus: () => Promise.reject(new Error("pool exhausted")) });
    expect(done.status).toBe("COMPLETED");
  });

  it("gives up after too many failed checks in a row", async () => {
    const server = await magicaWith({ [POLL]: [{ status: 503 }] });
    const error = await failureOf(fakeClockClient(server.url, { maxPollErrors: 3 }).client.waitForRun("run_1", { maxWaitMs: 60 * 60_000 }));
    expect(error.failure).toBe("SERVICE_ERROR");
    expect(server.count("GET")).toBe(4);
  });

  it("stops at once on an error that won't fix itself (a revoked key)", async () => {
    const server = await magicaWith({ [POLL]: [run("RUNNING"), { status: 401, json: fixture("error.401.json") }, run("COMPLETED")] });
    expect(await failureOf(fakeClockClient(server.url).client.waitForRun("run_1"))).toMatchObject({ failure: "AUTH" });
    expect(server.count("GET")).toBe(2);
  });

  it("keeps waiting on a status it doesn't know, rather than guessing it is over", async () => {
    const server = await magicaWith({ [POLL]: [run("PROCESSING"), run("COMPLETED")] });
    expect(await fakeClockClient(server.url).client.waitForRun("run_1")).toMatchObject({ status: "COMPLETED" });
  });

  it("retries an unreadable status answer (a proxy's error page, say), and gives up if it never becomes readable", async () => {
    const recovers = await magicaWith({ [POLL]: [{ status: 200, text: "<html>maintenance</html>" }, { status: 200, json: { nope: true } }, run("COMPLETED")] });
    expect(await fakeClockClient(recovers.url).client.waitForRun("run_1")).toMatchObject({ status: "COMPLETED" });
    const never = await magicaWith({ [POLL]: [{ status: 200, json: { nope: true } }] });
    expect(await failureOf(fakeClockClient(never.url, { maxPollErrors: 2 }).client.waitForRun("run_1", { maxWaitMs: 60 * 60_000 }))).toMatchObject({ failure: "BAD_RESPONSE" });
    expect(never.count("GET")).toBe(3);
  });

  it("stops polling as soon as it is cancelled", async () => {
    const server = await magicaWith({ [POLL]: [run("RUNNING")] });
    const controller = new AbortController();
    const { client } = fakeClockClient(server.url);
    await expect(
      client.waitForRun("run_1", {
        signal: controller.signal,
        onStatus: () => controller.abort(new DOMException("stopped by the user", "AbortError")),
      }),
    ).rejects.toThrow("stopped by the user");
    expect(server.count("GET")).toBe(1);
  });
});

describe("model schemas", () => {
  it("reads the model's live input schema and caches it", async () => {
    const server = await magicaWith({ ["GET /v1/models/*/schema"]: [{ status: 200, json: fixture("schema.gpt-image-2-text.json") }] });
    const { client, advance } = fakeClockClient(server.url, { schemaTtlMs: 60_000 });
    const schema = await client.getModelSchema("gpt-image-2-text");
    expect(schema.fields.map((f) => f.name)).toEqual(["prompt", "size", "quality", "background", "n", "output_format"]);
    await client.getModelSchema("gpt-image-2-text");
    expect(server.count("GET")).toBe(1);
    advance(60_001);
    await client.getModelSchema("gpt-image-2-text");
    expect(server.count("GET")).toBe(2);
  });

  it("shares one request when several tool calls need the same schema at once", async () => {
    const server = await magicaWith({ ["GET /v1/models/*/schema"]: [{ status: 200, json: fixture("schema.crop_image.json"), delayMs: 50 }] });
    const { client } = fakeClockClient(server.url);
    const schemas = await Promise.all(Array.from({ length: 5 }, () => client.getModelSchema("crop_image")));
    expect(new Set(schemas).size).toBe(1);
    expect(server.count("GET")).toBe(1);
  });

  it("tries again after a failed schema request instead of sharing the failure forever", async () => {
    const server = await magicaWith({ ["GET /v1/models/*/schema"]: [{ status: 503 }, { status: 200, json: fixture("schema.crop_image.json") }] });
    const { client } = fakeClockClient(server.url);
    await failureOf(client.getModelSchema("crop_image"));
    expect((await client.getModelSchema("crop_image")).fields.length).toBeGreaterThan(0);
  });

  it("falls back to the last schema it had when the catalog is down, and fails safely when it has none", async () => {
    const server = await magicaWith({ ["GET /v1/models/*/schema"]: [{ status: 200, json: fixture("schema.crop_image.json") }, { status: 503 }] });
    const { client, advance } = fakeClockClient(server.url, { schemaTtlMs: 1 });
    await client.getModelSchema("crop_image");
    advance(10);
    expect((await client.getModelSchema("crop_image")).fields[0]?.name).toBe("image_url");
    expect(await failureOf(client.getModelSchema("merge_videos"))).toMatchObject({ failure: "SERVICE_ERROR" });
  });
});

describe("resolveInput: input checked against the live schema", () => {
  const textSchema = fixture<ModelSchema>("schema.gpt-image-2-text.json");
  const editSchema = fixture<ModelSchema>("schema.gpt-image-2-edit.json");
  const cropSchema = fixture<ModelSchema>("schema.crop_image.json");
  const mergeSchema = fixture<ModelSchema>("schema.merge_videos.json");

  it("puts each choice in the exact form the model expects", () => {
    expect(resolveInput(textSchema, { prompt: "A fox", size: "auto", quality: "medium", background: "transparent", n: 2, output_format: "webp" })).toEqual({
      prompt: "A fox",
      size: "Auto",
      quality: "Medium",
      background: "Transparent",
      n: 2,
      output_format: "WebP",
    });
    expect(resolveInput(mergeSchema, { video_urls: ["https://a.test/1.mp4", "https://a.test/2.mp4"], transition: "fade" })).toEqual({ video_urls: ["https://a.test/1.mp4", "https://a.test/2.mp4"], transition: "fade" });
  });

  it.each([
    ["a missing required field", textSchema, { quality: "low" }, /prompt is required/],
    ["an empty required list", editSchema, { prompt: "night", uploadedImages: [] }, /uploadedImages is required/],
    ["a choice the model doesn't offer", textSchema, { prompt: "x", quality: "ultra" }, /quality must be one of High, Medium, Low/],
    ["a number choice it doesn't offer", textSchema, { prompt: "x", n: 5 }, /n must be one of 1, 2, 3, 4/],
    ["a field the model doesn't have", textSchema, { prompt: "x", style: "vivid" }, /style is not an option of this model/],
    ["text over the limit", textSchema, { prompt: "a".repeat(4001) }, /prompt must be at most 4000 characters/],
    ["a number over the maximum", cropSchema, { image_url: "https://a.test/a.png", x_percent: 120 }, /x_percent must be at most 100/],
    ["a number under the minimum", cropSchema, { image_url: "https://a.test/a.png", width_px: 0 }, /width_px must be at least 1/],
  ])("refuses %s, naming what is allowed", (_label, schema, input, reason) => {
    try {
      resolveInput(schema, input);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MagicaError);
      expect((error as MagicaError).failure).toBe("INVALID_INPUT");
      expect((error as MagicaError).message).toMatch(reason);
    }
  });

  it("leaves out fields that are undefined", () => {
    expect(resolveInput(cropSchema, { image_url: "https://a.test/a.png", x_percent: 0, y_px: undefined })).toEqual({ image_url: "https://a.test/a.png", x_percent: 0 });
  });
});

describe("secrets", () => {
  it("never puts the key in any error's message or detail", async () => {
    const replies: Reply[] = [{ status: 401, json: fixture("error.401.json") }, { status: 403 }, { status: 500 }, { close: true }, { status: 400, text: "bad" }];
    for (const reply of replies) {
      const server = await magicaWith({ [START]: [reply] });
      const error = await failureOf(fakeClockClient(server.url).client.startRun("x", { input: {} }));
      expect(`${error.message} ${error.detail} ${JSON.stringify(error)}`).not.toContain(TEST_KEY);
    }
  });
});

describe("helpers", () => {
  it("pollDelayMs: 3 s, then 5 s, 10 s, and at most 15 s", () => {
    expect([0, 14_999, 15_000, 29_999, 30_000, 59_999, 60_000, 600_000].map(pollDelayMs)).toEqual([3_000, 3_000, 5_000, 5_000, 10_000, 10_000, 15_000, 15_000]);
  });

  it("retryAfterMs reads seconds and HTTP dates, and ignores junk", () => {
    expect(retryAfterMs("12")).toBe(12_000);
    expect(retryAfterMs("0")).toBe(0);
    expect(retryAfterMs(new Date(1_000_000 + 4_000).toUTCString(), 1_000_000)).toBeLessThanOrEqual(4_000);
    expect(retryAfterMs("soon")).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("-5")).toBeNull();
  });

  it("the captured runs are all readable as runs", () => {
    for (const name of ["gpt_text", "gpt_edit", "crop", "merge"]) expect(MagicaRunSchema.safeParse(fixture(`run.${name}.completed.json`)).success).toBe(true);
  });

  it("the default sleep respects cancellation", async () => {
    vi.useFakeTimers();
    try {
      const { createMagicaClient } = await import("#src/lib/magica.js");
      const server = await magicaWith({ [POLL]: [run("RUNNING")] });
      const controller = new AbortController();
      const waiting = createMagicaClient({ baseUrl: server.url, apiKey: TEST_KEY }).waitForRun("run_1", { signal: controller.signal });
      controller.abort(new DOMException("stop", "AbortError"));
      await expect(waiting).rejects.toThrow("stop");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("oversized responses", () => {
  async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("refuses a body that declares a size over 1 MB, without reading it", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(202, { "Content-Type": "application/json", "Content-Length": String(MAX_RESPONSE_BYTES + 1) });
      res.write("{");
      setTimeout(() => res.destroy(), 200).unref();
    });
    const error = await failureOf(fakeClockClient(url).client.startRun("x", { input: {} }));
    expect(error).toMatchObject({ failure: "BAD_RESPONSE", outcomeUnknown: true });
    expect(error.detail).toMatch(/larger than 1048576 bytes/);
  });

  it("stops reading a body that grows past 1 MB without saying its size", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const chunk = "x".repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 40) {
          sent++;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
    });
    const error = await failureOf(fakeClockClient(url).client.getRun("run_1"));
    expect(error).toMatchObject({ failure: "BAD_RESPONSE" });
    expect(error.detail).toMatch(/larger than 1048576 bytes/);
  });
});

describe("responses that break off mid-body", () => {
  async function breakingServer(status: number, then: "close" | Reply[] = "close") {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      if (then !== "close" && calls > 1) {
        const reply = then[Math.min(calls - 2, then.length - 1)] ?? {};
        res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" }).end(JSON.stringify(reply.json));
        return;
      }
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": "500" });
      res.write('{"runId": "run_');
      setTimeout(() => res.destroy(), 20).unref();
    });
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls: () => calls };
  }

  it("on an accepted start: a service error, outcome unknown, never retried", async () => {
    const { url, calls } = await breakingServer(202);
    const error = await failureOf(fakeClockClient(url).client.startRun("x", { input: {} }));
    expect(error).toMatchObject({ failure: "SERVICE_ERROR", outcomeUnknown: true });
    expect(error.detail).toMatch(/broke off/);
    expect(calls()).toBe(1);
  });

  it("on a status check: retried, and the wait carries on", async () => {
    const { url } = await breakingServer(200, [run("COMPLETED")]);
    expect(await fakeClockClient(url).client.waitForRun("run_1")).toMatchObject({ status: "COMPLETED" });
  });

  it("on an error status: judged by the status alone", async () => {
    const { url } = await breakingServer(401);
    expect(await failureOf(fakeClockClient(url).client.getRun("run_1"))).toMatchObject({ failure: "AUTH" });
  });
});

describe("the shared schema request", () => {
  it("is not cancelled by one caller stopping: the others still get the schema", async () => {
    const server = await magicaWith({ ["GET /v1/models/*/schema"]: [{ status: 200, json: fixture("schema.crop_image.json"), delayMs: 100 }] });
    const { client } = fakeClockClient(server.url);
    const stopper = new AbortController();
    const first = client.getModelSchema("crop_image", stopper.signal);
    const second = client.getModelSchema("crop_image", new AbortController().signal);
    stopper.abort(new DOMException("user A stopped", "AbortError"));
    await expect(first).rejects.toThrow("user A stopped");
    expect((await second).fields[0]?.name).toBe("image_url");
    expect(server.count("GET")).toBe(1);
  });

  it("uses the last schema when the catalog can't be reached at all, and fails safely when it has none", async () => {
    const server = await magicaWith({ ["GET /v1/models/*/schema"]: [{ status: 200, json: fixture("schema.merge_videos.json") }, { close: true }] });
    const { client, advance } = fakeClockClient(server.url, { schemaTtlMs: 1 });
    await client.getModelSchema("merge_videos");
    advance(10);
    expect((await client.getModelSchema("merge_videos")).fields.map((f) => f.name)).toEqual(["video_urls", "transition"]);
    expect(await failureOf(client.getModelSchema("crop_image"))).toMatchObject({ failure: "SERVICE_ERROR" });
  });
});
