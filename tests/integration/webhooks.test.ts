import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import { Webhook } from "svix";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { V1MessageAcceptedSchema, V1ToolRunAcceptedSchema, WebhookEventSchema, type WebhookEvent } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { createApp } from "#src/app.js";
import { createLogger } from "#src/lib/logger.js";
import type { AgentTurnPayload } from "#src/agent/payload.js";
import { runAgentTurn } from "#src/agent/runTurn.js";
import { createApiKey } from "#src/services/apiKeys.js";
import { finalizeRun } from "#src/services/runs.js";
import { agentTools } from "#src/tools/index.js";
import { runMagicaInvocation } from "#src/tools/magicaInvocation.js";
import { DeliveryFailed, deliverWebhook, giveUpDelivery } from "#src/webhooks/deliver.js";
import { recordRunEvent } from "#src/webhooks/events.js";
import { app } from "../helpers/app.js";
import { fixtures, resetDb } from "../helpers/db.js";
import { fakeModel, finished, text } from "../helpers/fakeModel.js";
import { api } from "../helpers/http.js";
import { fakeClockClient, fixture, startMagicaServer } from "../helpers/magicaServer.js";
import { webhooks } from "../helpers/webhookMock.js";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // vitest.config.ts
const silent = pino({ level: "silent" });

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

/** A webhook receiver on this machine: answers each request with the next scripted status (the last repeats). */
async function receiver(statuses: (number | "hang" | { redirect: string })[] = [200]) {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      const next = statuses[Math.min(received.length - 1, statuses.length - 1)] ?? 200;
      if (next === "hang") return; // never answers
      if (typeof next === "object") return void res.writeHead(302, { location: next.redirect }).end();
      res.writeHead(next).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  servers.push(server);
  return { url, received };
}
const servers: Server[] = [];
beforeEach(resetDb);
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const server of magicaServers.splice(0)) await server.close();
});
const magicaServers: { close: () => Promise<void> }[] = [];

async function keyFor(userId: string) {
  await fixtures.user({ id: userId, balance: 10_000_000 });
  return (await createApiKey(userId, { label: "hooks", perMinute: 1000, perDay: 10_000 })).secret;
}
const send = (secret: string, body: object, headers: Record<string, string> = {}) => {
  let req = api(app).post("/v1/messages").set("x-api-key", secret).send(body);
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return req;
};
const deliver = (id: string, timeoutMs?: number) => deliverWebhook(id, { keyHex: KEY, allowLocalhost: true, ...(timeoutMs && { timeoutMs }) });
/** Checks a delivery the way a receiver would: the svix package verifies the signature (it throws if it's wrong). */
function verify(signingSecret: string, delivery: Received): WebhookEvent {
  new Webhook(signingSecret).verify(delivery.body, {
    "svix-id": delivery.headers["svix-id"] as string,
    "svix-timestamp": delivery.headers["svix-timestamp"] as string,
    "svix-signature": delivery.headers["svix-signature"] as string,
  });
  return WebhookEventSchema.parse(JSON.parse(delivery.body));
}
const deliveries = () => prisma.webhookDelivery.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, type: true, status: true, attempts: true, lastError: true } });

/** Runs the agent's turn for a sent message (a fake model answering in text), as the worker would. */
async function workTurn(runId: string, answer = "Hi there!") {
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
  const payload: AgentTurnPayload = { agentRunId: run.id, chatId: run.chatId, userId: run.userId, assistantMessageId: run.assistantMessageId, traceId: "t" };
  const model = fakeModel([text(answer), finished("provider/free", 12, 3)]);
  return runAgentTurn(payload, { stream: model.stream, emit: () => undefined, setStatus: () => undefined, triggerRunId: `run_${run.id}`, signal: new AbortController().signal, flushEveryMs: 0 });
}

describe("registering a webhook", () => {
  it("returns a signing secret once per destination: the same URL gets the same secret, stored only encrypted", async () => {
    const secret = await keyFor("u1");
    const hook = await receiver();
    const first = V1MessageAcceptedSchema.parse((await send(secret, { content: "One", webhook: { url: hook.url } })).body);
    expect(first.webhook?.signingSecret).toMatch(/^whsec_[A-Za-z0-9+/=]{40,}$/);
    await prisma.agentRun.updateMany({ data: { status: "COMPLETED" } });
    const second = V1MessageAcceptedSchema.parse((await send(secret, { content: "Two", webhook: { url: hook.url } })).body);
    expect(second.webhook?.signingSecret).toBe(first.webhook?.signingSecret);
    const endpoints = await prisma.webhookEndpoint.findMany();
    expect(endpoints).toHaveLength(1);
    expect(JSON.stringify(endpoints)).not.toContain(first.webhook!.signingSecret.slice(6));
    expect(await prisma.webhookSubscription.count()).toBe(2); // one per start
  });

  it("never writes the secret to the logs, nor to the stored answer of an idempotent start (a replay still gets it)", async () => {
    const lines: string[] = [];
    const logged = createApp({ log: createLogger("debug", { write: (line: string) => void lines.push(line) }), rateLimits: { authenticated: 1_000_000, anonymous: 1_000_000 }, sendLimit: 1_000_000 });
    const secret = await keyFor("u1");
    const hook = await receiver();
    const body = { content: "Logged?", webhook: { url: hook.url } };
    const first = await api(logged).post("/v1/messages").set("x-api-key", secret).set("Idempotency-Key", "hook-1").send(body);
    const again = await api(logged).post("/v1/messages").set("x-api-key", secret).set("Idempotency-Key", "hook-1").send(body);
    const signingSecret = V1MessageAcceptedSchema.parse(first.body).webhook!.signingSecret;
    expect(again.body).toEqual(first.body);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(lines.join("\n")).not.toContain(signingSecret.slice(6));
    expect(JSON.stringify(await prisma.idempotencyRecord.findMany())).not.toContain(signingSecret.slice(6));
  });

  it.each([
    ["a private address", "https://10.0.0.1/hook", "webhook.url: must be a public address."],
    ["the cloud metadata address", "https://169.254.169.254/latest/meta-data", "webhook.url: must be a public address."],
    ["plain http", "http://example.com/hook", "webhook.url: must use https."],
    ["credentials in the URL", "https://user:pass@example.com/hook", "webhook.url: must not contain a username or password."],
    ["a .internal name", "https://api.internal/hook", "webhook.url: must be a public address."],
    ["something that isn't a URL", "not a url", "webhook.url: must be a valid URL."],
  ])("refuses %s (400), starting nothing", async (_label, url, message) => {
    const secret = await keyFor("u1");
    const res = await send(secret, { content: "Hi", webhook: { url } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_FAILED", error: message });
    expect(await prisma.agentRun.count()).toBe(0);
    expect(await prisma.webhookEndpoint.count()).toBe(0);
  });

  it.each([
    ["an unknown event", { events: ["agent.exploded"] }],
    ["an event listed twice", { events: ["agent.started", "agent.started"] }],
    ["metadata over 4 KB", { metadata: { blob: "x".repeat(5000) } }],
    ["an unknown field", { secret: "mine" }],
  ])("refuses a webhook with %s", async (_label, extra) => {
    const secret = await keyFor("u1");
    const hook = await receiver();
    expect((await send(secret, { content: "Hi", webhook: { url: hook.url, ...extra } })).status).toBe(400);
  });
});

describe("events for a message", () => {
  it("sends agent.started then agent.completed, each once, signed, with the metadata echoed", async () => {
    const secret = await keyFor("u1");
    const hook = await receiver();
    const accepted = V1MessageAcceptedSchema.parse((await send(secret, { content: "Say hi", webhook: { url: hook.url, metadata: { orderId: "order_456" } } })).body);
    expect(await workTurn(accepted.runId)).toBe("completed");
    await finalizeRun(accepted.runId, { status: "COMPLETED" }); // a duplicate ending: no second event

    const recorded = await deliveries();
    expect(recorded.map((d) => d.type)).toEqual(["agent.started", "agent.completed"]);
    expect(webhooks.dispatched).toEqual(recorded.map((d) => d.id));
    for (const { id } of recorded) expect(await deliver(id)).toBe("delivered");

    const [started, completed] = hook.received.map((delivery) => verify(accepted.webhook!.signingSecret, delivery)) as [WebhookEvent, WebhookEvent];
    expect(started).toMatchObject({ success: true, type: "agent.started", runId: accepted.runId, metadata: { orderId: "order_456" }, error: null, data: { chatId: accepted.chatId, messageId: accepted.messageId, status: "RUNNING" } });
    expect(completed).toMatchObject({ success: true, type: "agent.completed", runId: accepted.runId, data: { status: "COMPLETED", model: "provider/free", usage: { inputTokens: 12, outputTokens: 3, credits: 0 } } });
    expect(() => verify(`whsec_${Buffer.from("not the secret, 32 bytes long....").toString("base64")}`, hook.received[0]!)).toThrow(); // only the real secret verifies
    expect(hook.received[0]!.headers["svix-id"]).toBe(`msg_${recorded[0]!.id}`);
    expect(hook.received[0]!.headers["user-agent"]).toBe("MagicaClone-Webhooks/1");
    expect(await deliveries()).toMatchObject([{ status: "DELIVERED", attempts: 1 }, { status: "DELIVERED", attempts: 1 }]);
    expect(await deliver(recorded[0]!.id)).toBe("skipped"); // never sent twice
    expect(hook.received).toHaveLength(2);
  });

  it("sends agent.failed with the reason, and agent.canceled when stopped", async () => {
    const secret = await keyFor("u1");
    const hook = await receiver();
    const failed = V1MessageAcceptedSchema.parse((await send(secret, { content: "One", webhook: { url: hook.url } })).body);
    await finalizeRun(failed.runId, { status: "FAILED", errorCode: "MODEL_DAILY_LIMIT", errorMessage: "The free model's daily limit is reached. It resets at 00:00 UTC." });
    const stopped = V1MessageAcceptedSchema.parse((await send(secret, { content: "Two", webhook: { url: hook.url } })).body);
    expect((await api(app).post(`/v1/runs/${stopped.runId}/cancel`).set("x-api-key", secret)).status).toBe(200);
    for (const { id } of await deliveries()) await deliver(id);
    const events = hook.received.map((delivery) => verify(failed.webhook!.signingSecret, delivery));
    expect(events).toMatchObject([
      { success: false, type: "agent.failed", runId: failed.runId, error: "The free model's daily limit is reached. It resets at 00:00 UTC.", data: { code: "MODEL_DAILY_LIMIT" } },
      { success: false, type: "agent.canceled", runId: stopped.runId, error: null },
    ]);
  });

  it("sends only the events asked for", async () => {
    const secret = await keyFor("u1");
    const hook = await receiver();
    const accepted = V1MessageAcceptedSchema.parse((await send(secret, { content: "Hi", webhook: { url: hook.url, events: ["agent.completed"] } })).body);
    await workTurn(accepted.runId);
    expect((await deliveries()).map((d) => d.type)).toEqual(["agent.completed"]);
  });

  it("sends nothing when no webhook was given", async () => {
    const secret = await keyFor("u1");
    const accepted = V1MessageAcceptedSchema.parse((await send(secret, { content: "Hi" })).body);
    await workTurn(accepted.runId);
    expect(await prisma.webhookDelivery.count()).toBe(0);
    expect(webhooks.dispatched).toEqual([]);
  });

  it("records an event once however often it is raised (a retried task)", async () => {
    const secret = await keyFor("u1");
    const hook = await receiver();
    const accepted = V1MessageAcceptedSchema.parse((await send(secret, { content: "Hi", webhook: { url: hook.url } })).body);
    await prisma.agentRun.update({ where: { id: accepted.runId }, data: { status: "RUNNING" } });
    const first = await prisma.$transaction((tx) => recordRunEvent(tx, accepted.runId, "agent.started"));
    const again = await prisma.$transaction((tx) => recordRunEvent(tx, accepted.runId, "agent.started"));
    expect([first.length, again.length]).toEqual([1, 0]);
  });
});

describe("events for a standalone tool run", () => {
  it("sends tool.completed with what it made, verified with the secret", async () => {
    const secret = await keyFor("u1");
    const hook = await receiver();
    const res = await api(app).post("/v1/tools/gpt-image-2").set("x-api-key", secret).send({ mode: "text", prompt: "A fox", webhook: { url: hook.url, metadata: { job: 7 } } });
    expect(res.status).toBe(202);
    const accepted = V1ToolRunAcceptedSchema.parse(res.body);
    expect(await prisma.toolInvocation.findUniqueOrThrow({ where: { id: accepted.runId } })).toMatchObject({ input: { mode: "text", prompt: "A fox" } }); // the webhook isn't part of the input

    const magica = await startMagicaServer({
      "POST /v1/nodes/*/run": [{ status: 202, json: { runId: "mg_hooked" } }],
      "GET /v1/nodes/runs/*": [{ status: 200, json: fixture("run.gpt_text.completed.json") }],
      "GET /v1/models/gpt-image-2-text/schema": [{ status: 200, json: fixture("schema.gpt-image-2-text.json") }],
    });
    magicaServers.push(magica);
    const clock = fakeClockClient(magica.url);
    await runMagicaInvocation(accepted.runId, { client: clock.client, now: clock.now, registry: agentTools, log: silent, signal: new AbortController().signal });

    const [delivery] = await deliveries();
    expect(delivery).toMatchObject({ type: "tool.completed" });
    await deliver(delivery!.id);
    const event = verify(accepted.webhook!.signingSecret, hook.received[0]!);
    expect(event).toMatchObject({ success: true, type: "tool.completed", runId: accepted.runId, metadata: { job: 7 }, data: { toolCallId: accepted.runId, tool: "gpt_image_2", status: "COMPLETED", credits: 1_000_000, assets: [{ type: "image" }] } });
    expect(JSON.stringify(event)).not.toContain("mg_hooked");
  });
});

describe("a standalone tool run that fails", () => {
  it("sends tool.failed with the reason, and charges nothing", async () => {
    const secret = await keyFor("u1");
    const hook = await receiver();
    const accepted = V1ToolRunAcceptedSchema.parse((await api(app).post("/v1/tools/gpt-image-2").set("x-api-key", secret).send({ mode: "text", prompt: "A fox", webhook: { url: hook.url } })).body);
    const magica = await startMagicaServer({
      "POST /v1/nodes/*/run": [{ status: 202, json: { runId: "mg_failing" } }],
      "GET /v1/nodes/runs/*": [{ status: 200, json: fixture("run.gpt_text.failed.json") }],
      "GET /v1/models/gpt-image-2-text/schema": [{ status: 200, json: fixture("schema.gpt-image-2-text.json") }],
    });
    magicaServers.push(magica);
    const clock = fakeClockClient(magica.url);
    await runMagicaInvocation(accepted.runId, { client: clock.client, now: clock.now, registry: agentTools, log: silent, signal: new AbortController().signal });
    const [delivery] = await deliveries();
    expect(delivery).toMatchObject({ type: "tool.failed" });
    await deliver(delivery!.id);
    expect(verify(accepted.webhook!.signingSecret, hook.received[0]!)).toMatchObject({ success: false, type: "tool.failed", runId: accepted.runId, error: expect.any(String) as unknown, data: { status: "FAILED", credits: 0 } });
  });
});

describe("delivering", () => {
  async function oneDelivery(statuses: Parameters<typeof receiver>[0]) {
    const secret = await keyFor("u1");
    const hook = await receiver(statuses);
    const accepted = V1MessageAcceptedSchema.parse((await send(secret, { content: "Hi", webhook: { url: hook.url, events: ["agent.canceled"] } })).body);
    await finalizeRun(accepted.runId, { status: "CANCELLED" });
    return { hook, id: (await deliveries())[0]!.id };
  }

  it("retries a failed delivery until it is received, then stops", async () => {
    const { hook, id } = await oneDelivery([500, 200]);
    await expect(deliver(id)).rejects.toEqual(new DeliveryFailed("answered HTTP 500"));
    expect(await deliveries()).toMatchObject([{ status: "PENDING", attempts: 1, lastError: "answered HTTP 500" }]);
    expect(await deliver(id)).toBe("delivered");
    expect(await deliveries()).toMatchObject([{ status: "DELIVERED", attempts: 2, lastError: null }]);
    expect(hook.received[0]!.headers["svix-id"]).toBe(hook.received[1]!.headers["svix-id"]); // the same event both times
  });

  it("doesn't follow a redirect", async () => {
    const target = await receiver();
    const { id } = await oneDelivery([{ redirect: target.url }]);
    await expect(deliver(id)).rejects.toThrow("answered HTTP 302 (redirects aren't followed)");
    expect(target.received).toEqual([]);
  });

  it("gives up waiting for a receiver that doesn't answer", async () => {
    const { id } = await oneDelivery(["hang"]);
    await expect(deliver(id, 200)).rejects.toThrow("no answer within 0.2 seconds");
  });

  it("refuses an address that has become private since it was registered (checked on connect)", async () => {
    const { id } = await oneDelivery([200]);
    const delivery = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id }, include: { subscription: true } });
    // the name now points at this machine (as a rebinding attack would): https, and localhost not allowed in production
    await prisma.webhookEndpoint.update({ where: { id: delivery.subscription.endpointId }, data: { url: "https://localhost:9/hook" } });
    await expect(deliverWebhook(id, { keyHex: KEY, allowLocalhost: false })).rejects.toThrow("localhost resolves only to private or reserved addresses");
  });

  it("marks a delivery failed after its last attempt", async () => {
    const { id } = await oneDelivery([500]);
    await expect(deliver(id)).rejects.toThrow();
    await giveUpDelivery(id);
    expect(await deliveries()).toMatchObject([{ status: "FAILED", lastError: "answered HTTP 500" }]);
    expect(await deliver(id)).toBe("skipped");
  });
});
