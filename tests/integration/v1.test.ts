import { beforeEach, describe, expect, it } from "vitest";
import {
  ChatListResponseSchema,
  CreditsResponseSchema,
  MediaListResponseSchema,
  MessageListResponseSchema,
  RespondWaitpointResponseSchema,
  V1ErrorResponseSchema,
  V1MessageAcceptedSchema,
  V1RunResponseSchema,
} from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { createApiKey } from "#src/services/apiKeys.js";
import { finalizeRun } from "#src/services/runs.js";
import { createApp } from "#src/app.js";
import { app } from "../helpers/app.js";
import { activeTurn, fixtures, resetDb } from "../helpers/db.js";
import { api } from "../helpers/http.js";
import { trigger } from "../helpers/triggerMock.js";

beforeEach(resetDb);

const HOUR = 3_600_000;

async function keyFor(userId: string, limits: { perMinute?: number; perDay?: number } = {}, balance = 10_000_000) {
  if (!(await prisma.user.findUnique({ where: { id: userId } }))) await fixtures.user({ id: userId, balance });
  const { apiKey, secret } = await createApiKey(userId, { label: "test", perMinute: limits.perMinute ?? 1000, perDay: limits.perDay ?? 10_000 });
  return { id: apiKey.id, secret };
}

/** Requests as an API key holder (x-api-key by default, or Authorization: Bearer). */
const withKey = (secret: string, how: "x-api-key" | "bearer" = "x-api-key") => {
  const set = <T extends { set: (name: string, value: string) => T }>(req: T) => (how === "bearer" ? req.set("Authorization", `Bearer ${secret}`) : req.set("x-api-key", secret));
  return {
    get: (path: string) => set(api(app).get(path)),
    post: (path: string) => set(api(app).post(path)),
  };
};
const send = (secret: string, body: object, headers: Record<string, string> = {}) => {
  let req = withKey(secret).post("/v1/messages").send(body);
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return req;
};
const error = (res: { body: unknown }) => V1ErrorResponseSchema.parse(res.body);

describe("signing in", () => {
  it("takes an API key in x-api-key or as a Bearer token, and a session token too", async () => {
    const { secret } = await keyFor("u1");
    for (const how of ["x-api-key", "bearer"] as const) {
      const res = await withKey(secret, how).get("/v1/credits");
      expect(res.status, how).toBe(200);
      expect(res.headers["x-api-version"]).toBe("1");
    }
    const session = await api(app).get("/v1/credits").set("Authorization", "Bearer test:u1");
    expect(session.status).toBe(200);
  });

  it("refuses a key that is unknown, revoked, expired or malformed, all the same way, with the trace id", async () => {
    const { secret, id } = await keyFor("u1");
    const expired = await keyFor("u1");
    await prisma.apiKey.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const unknown = `mgc_${"A".repeat(43)}`;
    await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    for (const bad of [secret, expired.secret, unknown, "mgc_short", "gx_realmagicakey"]) {
      const res = await withKey(bad).get("/v1/credits");
      expect(res.status, bad).toBe(401);
      const body = error(res);
      expect(body).toMatchObject({ code: "UNAUTHORIZED", error: "That API key isn't valid. Check it, or create a new one." });
      expect(body.traceId).toBe(res.headers["x-trace-id"]);
      expect(res.headers["www-authenticate"]).toBe("Bearer");
      expect(res.headers["x-api-version"]).toBe("1");
    }
  });

  it("refuses a request with nothing to sign in with", async () => {
    const res = await api(app).get("/v1/chats");
    expect(res.status).toBe(401);
    expect(error(res).error).toMatch(/Use an API key/);
  });

  it("stops working as soon as the key is revoked", async () => {
    const { secret, id } = await keyFor("u1");
    expect((await withKey(secret).get("/v1/chats")).status).toBe(200);
    await api(app).delete(`/api/api-keys/${id}`).set("Authorization", "Bearer test:u1");
    expect((await withKey(secret).get("/v1/chats")).status).toBe(401);
  });

  it("records when the key was last used", async () => {
    const { secret, id } = await keyFor("u1");
    await withKey(secret).get("/v1/chats");
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id } })).lastUsedAt).toBeInstanceOf(Date);
  });
});

describe("per-key limits", () => {
  it("holds a key to its per-minute limit, counted across both ways of sending it, with Retry-After", async () => {
    const { secret } = await keyFor("u1", { perMinute: 3 });
    expect((await withKey(secret).get("/v1/chats")).status).toBe(200);
    expect((await withKey(secret, "bearer").get("/v1/chats")).status).toBe(200);
    expect((await withKey(secret).get("/v1/credits")).status).toBe(200);
    const res = await withKey(secret, "bearer").get("/v1/chats");
    expect(res.status).toBe(429);
    expect(error(res)).toMatchObject({ code: "RATE_LIMITED", error: "This API key's per-minute limit of 3 requests is used up.", details: { window: "minute", limit: 3 } });
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);

    const other = await keyFor("u1", { perMinute: 3 }); // each key has its own allowance
    expect((await withKey(other.secret).get("/v1/chats")).status).toBe(200);
  });

  it("holds a key to its daily limit", async () => {
    const { secret } = await keyFor("u1", { perDay: 2 });
    await withKey(secret).get("/v1/chats");
    await withKey(secret).get("/v1/chats");
    const res = await withKey(secret).get("/v1/chats");
    expect(res.status).toBe(429);
    expect(error(res).details).toMatchObject({ window: "day", limit: 2 });
  });
});

describe("POST /v1/messages", () => {
  it("starts a turn in a new chat and returns at once with the run to poll", async () => {
    const { secret } = await keyFor("u1");
    const res = await send(secret, { content: "Say hi" });
    expect(res.status).toBe(202);
    const accepted = V1MessageAcceptedSchema.parse(res.body);
    expect(accepted.status).toBe("queued");
    expect(res.headers["idempotent-replayed"]).toBe("false");
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: accepted.chatId } })).toMatchObject({ userId: "u1", title: "Say hi" });
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: accepted.runId } })).toMatchObject({ chatId: accepted.chatId, mode: "DEFAULT", triggerMessageId: accepted.messageId });
    expect(trigger.dispatches).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain(trigger.dispatches[0]!.triggerRunId); // never Trigger.dev's ids
  });

  it("sends into an existing chat of the user's, in plan mode if asked", async () => {
    const { secret } = await keyFor("u1");
    const chat = await fixtures.chat("u1");
    const res = await send(secret, { chatId: chat.id, content: "Plan a fox picture", mode: "plan" });
    expect(res.status).toBe(202);
    const { runId, chatId } = V1MessageAcceptedSchema.parse(res.body);
    expect(chatId).toBe(chat.id);
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ mode: "PLAN" });
  });

  it("won't send into another user's chat (404, nothing created)", async () => {
    const { secret } = await keyFor("u1");
    await fixtures.user({ id: "u2" });
    const theirs = await fixtures.chat("u2");
    const res = await send(secret, { chatId: theirs.id, content: "Hi" });
    expect(res.status).toBe(404);
    expect(await prisma.message.count()).toBe(0);
  });

  it("removes the new chat if the send doesn't go (here: not enough credits)", async () => {
    const { secret } = await keyFor("u1", {}, 0);
    const res = await send(secret, { content: "Hi" });
    expect(res.status).toBe(402);
    expect(error(res).code).toBe("INSUFFICIENT_CREDITS");
    expect(await prisma.chat.count()).toBe(0);
  });

  it.each([
    ["no content", {}, 400],
    ["content over 32,000 characters", { content: "x".repeat(32_001) }, 400],
    ["a client message id (use Idempotency-Key instead)", { content: "Hi", clientMessageId: "0b4f6f3e-3c2e-4a8e-9a55-7c0d7c1d2e3f" }, 400],
    ["a chat id that isn't one", { content: "Hi", chatId: "not a chat!" }, 400],
  ])("refuses %s", async (_label, body, status) => {
    const { secret } = await keyFor("u1");
    const res = await send(secret, body);
    expect(res.status).toBe(status);
    expect(error(res).traceId).toBe(res.headers["x-trace-id"]);
    expect(await prisma.chat.count()).toBe(0);
  });

  it("refuses a body over 1 MB with 413", async () => {
    const { secret } = await keyFor("u1");
    const res = await send(secret, { content: "x", padding: "y".repeat(1_100_000) });
    expect(res.status).toBe(413);
    expect(error(res).code).toBe("PAYLOAD_TOO_LARGE");
  });

  describe("Idempotency-Key", () => {
    it("gives the first answer back for a repeat, without a second turn", async () => {
      const { secret } = await keyFor("u1");
      const first = await send(secret, { content: "Once" }, { "Idempotency-Key": "order-42" });
      const again = await send(secret, { content: "Once" }, { "Idempotency-Key": "order-42" });
      expect([first.status, again.status]).toEqual([202, 202]);
      expect(again.body).toEqual(first.body);
      expect([first.headers["idempotent-replayed"], again.headers["idempotent-replayed"]]).toEqual(["false", "true"]);
      expect(await prisma.agentRun.count()).toBe(1);
      expect(await prisma.chat.count()).toBe(1);
    });

    it("refuses the same key for a different request (409), and keeps keys apart per user", async () => {
      const { secret } = await keyFor("u1");
      await send(secret, { content: "One thing" }, { "Idempotency-Key": "k1" });
      const different = await send(secret, { content: "Another thing" }, { "Idempotency-Key": "k1" });
      expect(different.status).toBe(409);
      expect(error(different)).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", error: "This Idempotency-Key was already used for a different request." });
      const other = await keyFor("u2");
      expect((await send(other.secret, { content: "Another thing" }, { "Idempotency-Key": "k1" })).status).toBe(202);
    });

    it("refuses a repeat that arrives while the first is still being handled", async () => {
      const { secret } = await keyFor("u1");
      trigger.dispatchHangs = true; // the first send is stuck handing the turn to Trigger.dev
      const first = send(secret, { content: "Slow" }, { "Idempotency-Key": "slow-1" }).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const again = await send(secret, { content: "Slow" }, { "Idempotency-Key": "slow-1" });
      expect(again.status).toBe(409);
      expect(error(again).error).toBe("A request with this Idempotency-Key is still being handled. Try again in a moment.");
      expect((await first).status).toBe(503); // the stuck one gives up (and releases the key)
    }, 20_000);

    it("lets a failed request be tried again with the same key", async () => {
      const { secret } = await keyFor("u1", {}, 0);
      expect((await send(secret, { content: "Retry me" }, { "Idempotency-Key": "retry-1" })).status).toBe(402);
      await prisma.user.update({ where: { id: "u1" }, data: { balance: 10_000_000 } });
      expect((await send(secret, { content: "Retry me" }, { "Idempotency-Key": "retry-1" })).status).toBe(202);
    });

    it("frees a key after 24 hours", async () => {
      const { secret } = await keyFor("u1");
      await send(secret, { content: "Old" }, { "Idempotency-Key": "daily" });
      await prisma.idempotencyRecord.updateMany({ data: { createdAt: new Date(Date.now() - 25 * HOUR) } });
      await prisma.agentRun.updateMany({ data: { status: "COMPLETED" } }); // the chat is free for another turn
      const fresh = await send(secret, { content: "New" }, { "Idempotency-Key": "daily" });
      expect(fresh.status).toBe(202);
      expect(fresh.headers["idempotent-replayed"]).toBe("false");
    });

    it("refuses a key that isn't 1 to 255 visible ASCII characters", async () => {
      const { secret } = await keyFor("u1");
      for (const bad of ["has space", "x".repeat(256)]) expect((await send(secret, { content: "Hi" }, { "Idempotency-Key": bad })).status).toBe(400);
    });
  });
});

describe("GET /v1/runs/:runId", () => {
  let runs = 0;
  async function aRun(userId = "u1") {
    const chat = await fixtures.chat(userId);
    return activeTurn(chat.id, userId, { status: "RUNNING", triggerRunId: `run_trigger_secret_${++runs}` });
  }

  it("shows a run in progress, never with Trigger.dev's or Magica's ids", async () => {
    const { secret } = await keyFor("u1");
    const { run, assistantMessage } = await aRun();
    await prisma.message.update({ where: { id: assistantMessage.id }, data: { contentBlocks: [{ type: "text", content: "Working on " }, { type: "text", content: "it" }] as never } });
    const invocation = await prisma.toolInvocation.create({
      data: { agentRunId: run.id, toolCallId: "s1-a", toolName: "gpt_image_2", input: { prompt: "A fox", api_key: "hidden" }, status: "RUNNING", magicaRunId: "mg_secret_run", providerCost: 7644 },
    });
    const res = await withKey(secret).get(`/v1/runs/${run.id}`);
    expect(res.status).toBe(200);
    const body = V1RunResponseSchema.parse(res.body).run;
    expect(body).toMatchObject({ id: run.id, status: "running", mode: "default", reply: { messageId: assistantMessage.id, text: "Working on it" }, pendingWaitpoint: null });
    expect(body.toolCalls).toEqual([expect.objectContaining({ id: invocation.id, tool: "gpt_image_2", status: "running", input: { prompt: "A fox" }, credits: null, assets: [] })]);
    const raw = JSON.stringify(res.body);
    for (const internal of ["run_trigger_secret_", "mg_secret_run", "7644", "hidden"]) expect(raw).not.toContain(internal);
  });

  it("shows a finished run: usage, credits, what each tool made, and the reply's media", async () => {
    const { secret } = await keyFor("u1");
    const { run, assistantMessage } = await aRun();
    const invocation = await prisma.toolInvocation.create({
      data: { agentRunId: run.id, toolCallId: "s1-a", toolName: "gpt_image_2", input: { prompt: "A fox" }, status: "COMPLETED", creditCost: 1_000_000, durationMs: 31_000, completedAt: new Date() },
    });
    await prisma.mediaAsset.create({ data: { userId: "u1", source: "GENERATED", type: "IMAGE", url: "https://g.tlcdn.com/gen/fox.png", toolInvocationId: invocation.id, width: 1024, height: 1024, mimeType: "image/png" } });
    const blocks = [{ type: "text", content: "Here is your fox." }, { type: "image", url: "https://g.tlcdn.com/gen/fox.png", mimeType: "image/png", width: 1024, height: 1024 }];
    await finalizeRun(run.id, { status: "COMPLETED", blocks: blocks as never, model: "provider/free", inputTokens: 120, outputTokens: 30 });
    const body = V1RunResponseSchema.parse((await withKey(secret).get(`/v1/runs/${run.id}`)).body).run;
    expect(body).toMatchObject({
      status: "completed",
      model: "provider/free",
      usage: { inputTokens: 120, outputTokens: 30, credits: 1_000_000 },
      error: null,
      reply: { messageId: assistantMessage.id, text: "Here is your fox.", assets: [{ type: "image", url: "https://g.tlcdn.com/gen/fox.png", mimeType: "image/png", width: 1024, height: 1024 }] },
      completedAt: expect.any(String) as unknown,
    });
    expect(body.toolCalls[0]).toMatchObject({ status: "completed", credits: 1_000_000, durationMs: 31_000, assets: [{ type: "image", url: "https://g.tlcdn.com/gen/fox.png" }] });
  });

  it("shows a failed run's reason, and a run that waits for an answer", async () => {
    const { secret } = await keyFor("u1");
    const failed = await aRun();
    await finalizeRun(failed.run.id, { status: "FAILED", errorCode: "MODEL_DAILY_LIMIT", errorMessage: "The free model's daily limit is reached. It resets at 00:00 UTC." });
    expect(V1RunResponseSchema.parse((await withKey(secret).get(`/v1/runs/${failed.run.id}`)).body).run).toMatchObject({
      status: "failed",
      error: { code: "MODEL_DAILY_LIMIT", message: "The free model's daily limit is reached. It resets at 00:00 UTC." },
    });

    const waiting = await aRun();
    const plan = { title: "Fox", overview: "A fox", steps: [{ title: "Generate", tool: "gpt_image_2", estimatedCredits: 1_000_000 }], totalCredits: 1_000_000 };
    const wp = await prisma.waitpoint.create({ data: { agentRunId: waiting.run.id, type: "PLAN", triggerTokenId: "waitpoint_tok", payload: plan, expiresAt: new Date(Date.now() + HOUR) } });
    const body = V1RunResponseSchema.parse((await withKey(secret).get(`/v1/runs/${waiting.run.id}`)).body).run;
    expect(body).toMatchObject({ status: "waiting", pendingWaitpoint: { id: wp.id, type: "plan", status: "pending", payload: plan } });
    expect(JSON.stringify(body)).not.toContain("waitpoint_tok");

    // and the user can answer it through the public API
    const answered = await withKey(secret).post(`/v1/waitpoints/${wp.id}/respond`).send({ action: "approve" });
    expect(answered.status).toBe(200);
    expect(RespondWaitpointResponseSchema.parse(answered.body).waitpoint.status).toBe("approved");
  });

  it("ends a run whose worker died, rather than leave the caller polling forever", async () => {
    const { secret } = await keyFor("u1");
    const chat = await fixtures.chat("u1");
    const { run } = await activeTurn(chat.id, "u1", { status: "RUNNING", triggerRunId: "run_dead", ageMs: 90_000, quietMs: 60_000 }); // nothing saved for a minute
    trigger.statuses.set("run_dead", "CRASHED");
    const body = V1RunResponseSchema.parse((await withKey(secret).get(`/v1/runs/${run.id}`)).body).run;
    expect(body).toMatchObject({ status: "failed", error: { code: "AGENT_CRASHED" } });
  });

  it("is the owner's alone (another user's run, or no such run: 404)", async () => {
    const { secret } = await keyFor("u1");
    await fixtures.user({ id: "u2" });
    const { run } = await aRun("u2");
    for (const path of [`/v1/runs/${run.id}`, "/v1/runs/cmnotarun0000000000000", "/v1/runs/not a run!"]) {
      expect((await withKey(secret).get(path)).status, path).toBe(404);
    }
    expect((await withKey(secret).post(`/v1/runs/${run.id}/cancel`)).status).toBe(404);
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "RUNNING" });
  });
});

describe("POST /v1/runs/:runId/cancel", () => {
  it("stops a run that is going, and returns a finished one as it stands", async () => {
    const { secret } = await keyFor("u1");
    const chat = await fixtures.chat("u1");
    const { run } = await activeTurn(chat.id, "u1", { status: "RUNNING", triggerRunId: "run_to_stop" });
    const stopped = await withKey(secret).post(`/v1/runs/${run.id}/cancel`);
    expect(stopped.status).toBe(200);
    expect(V1RunResponseSchema.parse(stopped.body).run.status).toBe("cancelled");
    expect(trigger.cancelled).toEqual(["run_to_stop"]);
    const again = await withKey(secret).post(`/v1/runs/${run.id}/cancel`);
    expect(V1RunResponseSchema.parse(again.body).run.status).toBe("cancelled");
    expect(trigger.cancelled).toHaveLength(1);
  });
});

describe("reads", () => {
  it("lists the user's chats and a chat's messages, refusing another user's chat", async () => {
    const { secret } = await keyFor("u1");
    const sent = V1MessageAcceptedSchema.parse((await send(secret, { content: "Hello there" })).body);
    const chats = ChatListResponseSchema.parse((await withKey(secret).get("/v1/chats")).body);
    expect(chats.chats.map((c) => c.id)).toEqual([sent.chatId]);
    const messages = MessageListResponseSchema.parse((await withKey(secret).get(`/v1/chats/${sent.chatId}/messages`)).body);
    expect(messages.messages.map((m) => m.content)).toEqual(["Hello there"]);

    await fixtures.user({ id: "u2" });
    const theirs = await fixtures.chat("u2");
    expect((await withKey(secret).get(`/v1/chats/${theirs.id}/messages`)).status).toBe(404);
  });

  it("refuses a cursor made by another endpoint", async () => {
    const { secret } = await keyFor("u1");
    const chat = await fixtures.chat("u1");
    for (let i = 0; i < 3; i++) await fixtures.chat("u1");
    const page = ChatListResponseSchema.parse((await withKey(secret).get("/v1/chats?limit=1")).body);
    expect(page.cursor).toBeTruthy();
    const res = await withKey(secret).get(`/v1/chats/${chat.id}/messages?cursor=${page.cursor}`);
    expect(res.status).toBe(400);
    expect(error(res).code).toBe("VALIDATION_FAILED");
  });

  it("shows the user's credits and media library", async () => {
    const { secret } = await keyFor("u1");
    await prisma.mediaAsset.create({ data: { userId: "u1", source: "GENERATED", type: "IMAGE", url: "https://g.tlcdn.com/gen/a.png", prompt: "A fox" } });
    expect(CreditsResponseSchema.parse((await withKey(secret).get("/v1/credits")).body)).toMatchObject({ balance: 10_000_000 });
    expect(MediaListResponseSchema.parse((await withKey(secret).get("/v1/media")).body).media.map((m) => m.prompt)).toEqual(["A fox"]);
  });

  it("answers an unknown endpoint with a 404 that has the trace id", async () => {
    const { secret } = await keyFor("u1");
    const res = await withKey(secret).get("/v1/nothing-here");
    expect(res.status).toBe(404);
    expect(error(res)).toMatchObject({ code: "NOT_FOUND", traceId: res.headers["x-trace-id"] });
  });
});

describe("limits shared with the app, and failed sign-ins", () => {
  it("shares one send allowance per user between the app's API and /v1", async () => {
    const limited = createApp({ rateLimits: { authenticated: 1_000_000, anonymous: 1_000_000 }, sendLimit: 2 });
    const { secret } = await keyFor("u1");
    const first = await fixtures.chat("u1");
    expect((await api(limited).post(`/api/chats/${first.id}/messages`).set("Authorization", "Bearer test:u1").send({ content: "One" })).status).toBe(201);
    expect((await api(limited).post("/v1/messages").set("x-api-key", secret).send({ content: "Two" })).status).toBe(202);
    const third = await api(limited).post("/v1/messages").set("x-api-key", secret).send({ content: "Three" });
    expect(third.status).toBe(429);
    expect(error(third).code).toBe("RATE_LIMITED");
  });

  it("slows down an address that keeps failing to sign in", async () => {
    const fresh = createApp({ rateLimits: { authenticated: 1_000_000, anonymous: 1_000_000 }, sendLimit: 1_000_000 });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await api(fresh).get("/v1/chats").set("x-api-key", `mgc_${"B".repeat(43)}`)).status);
    expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
