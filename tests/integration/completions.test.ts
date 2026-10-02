import { beforeEach, describe, expect, it } from "vitest";
import { V1ChatCompletionPendingSchema, V1ChatCompletionSchema, V1ErrorResponseSchema } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { createApp } from "#src/app.js";
import { loadConversation } from "#src/agent/context.js";
import { createApiKey } from "#src/services/apiKeys.js";
import { createCompletion } from "#src/services/completions.js";
import { finalizeRun } from "#src/services/runs.js";
import { fixtures, resetDb } from "../helpers/db.js";
import { api } from "../helpers/http.js";

beforeEach(resetDb);

// a short wait, so "the answer takes longer" doesn't take a minute
const app = createApp({ rateLimits: { authenticated: 1_000_000, anonymous: 1_000_000 }, sendLimit: 1_000_000, completionWaitMs: 1_500 });

async function keyFor(userId: string, balance = 10_000_000) {
  await fixtures.user({ id: userId, balance });
  return (await createApiKey(userId, { label: "completions", perMinute: 1000, perDay: 10_000 })).secret;
}
const complete = (secret: string, body: unknown, headers: Record<string, string> = {}) => {
  let req = api(app).post("/v1/chat/completions").set("x-api-key", secret).send(body as object);
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return req.then((res) => res);
};
const ask = (content: string) => ({ model: "openrouter/free", messages: [{ role: "user", content }] });

/** Plays the worker: once the request's run exists, ends it as the agent would. */
async function answerNextRun(ending: Parameters<typeof finalizeRun>[1]) {
  for (let i = 0; i < 100; i++) {
    const run = await prisma.agentRun.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "desc" } });
    if (run) {
      await prisma.agentRun.update({ where: { id: run.id }, data: { status: "RUNNING" } });
      await finalizeRun(run.id, ending);
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no run appeared");
}
const answered = (text: string) => ({ status: "COMPLETED" as const, blocks: [{ type: "text" as const, content: text }], model: "provider/free-model", inputTokens: 42, outputTokens: 7 });

describe("POST /v1/chat/completions", () => {
  it("answers in the chat-completions format once the agent has answered", async () => {
    const secret = await keyFor("u1");
    const pending = complete(secret, { ...ask("Say hi"), temperature: 0.2, max_tokens: 50 }); // other fields are fine
    const run = await answerNextRun(answered("Hi there!"));
    const res = await pending;
    expect(res.status).toBe(200);
    expect(V1ChatCompletionSchema.parse(res.body)).toEqual({
      id: `chatcmpl_${run.id}`,
      object: "chat.completion",
      created: expect.any(Number) as unknown,
      model: "provider/free-model",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi there!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
      run_id: run.id,
    });
    expect(res.headers["x-api-version"]).toBe("1");
  });

  it("hands back the run to poll when the answer takes longer (202)", async () => {
    const secret = await keyFor("u1");
    const res = await complete(secret, ask("Write a long story"));
    expect(res.status).toBe(202);
    const pending = V1ChatCompletionPendingSchema.parse(res.body);
    expect(pending).toMatchObject({ object: "chat.completion.pending", status: "queued" });
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: pending.run_id } })).toMatchObject({ chatId: pending.chat_id });
  });

  it("gives the agent the whole conversation: instructions first, then the turns in order, then the question", async () => {
    const secret = await keyFor("u1");
    const pending = complete(secret, {
      model: "openrouter/free",
      messages: [
        { role: "system", content: "Answer like a pirate." },
        { role: "user", content: "What's 2 + 2?" },
        { role: "assistant", content: [{ type: "text", text: "Arr, 4." }] },
        { role: "developer", content: "Keep it short." },
        { role: "user", content: [{ type: "text", text: "And 3 + 3?" }] },
      ],
    });
    const run = await answerNextRun(answered("Arr, 6."));
    expect((await pending).status).toBe(200);
    expect(await loadConversation(run.chatId, run.triggerMessageId)).toEqual([
      { role: "user", content: "Instructions for this conversation:\nAnswer like a pirate.\n\nKeep it short.\n\nWhat's 2 + 2?" },
      { role: "assistant", content: "Arr, 4." },
      { role: "user", content: "And 3 + 3?" },
    ]);
    // the conversation is kept as a chat, titled from the question
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: run.chatId } })).toMatchObject({ userId: "u1", title: "And 3 + 3?" });
  });

  it("says why when the agent couldn't answer (503 with the run)", async () => {
    const secret = await keyFor("u1");
    const pending = complete(secret, ask("Say hi"));
    const run = await answerNextRun({ status: "FAILED", errorCode: "MODEL_DAILY_LIMIT", errorMessage: "The free model's daily limit is reached. It resets at 00:00 UTC." });
    const res = await pending;
    expect(res.status).toBe(503);
    expect(V1ErrorResponseSchema.parse(res.body)).toMatchObject({ code: "SERVICE_UNAVAILABLE", error: "The free model's daily limit is reached. It resets at 00:00 UTC.", details: { runId: run.id, reason: "MODEL_DAILY_LIMIT" } });
  });

  it("gives the first answer back for a repeated Idempotency-Key", async () => {
    const secret = await keyFor("u1");
    const pending = complete(secret, ask("Say hi"), { "Idempotency-Key": "hi-1" });
    await answerNextRun(answered("Hi!"));
    const first = await pending; // (a repeat while it is still waiting would be a 409)
    const again = await complete(secret, ask("Say hi"), { "Idempotency-Key": "hi-1" });
    expect(again.body).toEqual(first.body);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(await prisma.agentRun.count()).toBe(1);
  });

  it("removes the new chat when the turn can't start (402)", async () => {
    const secret = await keyFor("u1", 0);
    const res = await complete(secret, { model: "openrouter/free", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }] });
    expect(res.status).toBe(402);
    expect(await prisma.chat.count()).toBe(0);
    expect(await prisma.message.count()).toBe(0);
  });

  it.each([
    ["another model", { model: "openai/gpt-4o", messages: [{ role: "user", content: "Hi" }] }, 'model: Only "openrouter/free" is available.'],
    ["streaming", { ...ask("Hi"), stream: true }, "stream: Streaming isn't supported: leave stream out or set it to false."],
    ["tool definitions", { ...ask("Hi"), tools: [{ type: "function", function: { name: "x" } }] }, "tools: Tool definitions aren't supported: the agent uses its own tools."],
    ["a last message that isn't the user's", { model: "openrouter/free", messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }] }, "messages: The last message must be from the user."],
    ["a blank question", ask("   "), "messages: The last message can't be empty."],
    ["image content", { model: "openrouter/free", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://a.test/x.png" } }] }] }, undefined],
    ["a tool message", { model: "openrouter/free", messages: [{ role: "tool", content: "42" }, { role: "user", content: "Hi" }] }, undefined],
    ["no messages", { model: "openrouter/free", messages: [] }, undefined],
  ])("refuses %s (400), starting nothing", async (_label, body, message) => {
    const secret = await keyFor("u1");
    const res = await complete(secret, body);
    expect(res.status).toBe(400);
    const error = V1ErrorResponseSchema.parse(res.body);
    expect(error.code).toBe("VALIDATION_FAILED");
    if (message) expect(error.error).toBe(message);
    expect(await prisma.chat.count()).toBe(0);
  });
});

describe("waiting for the answer", () => {
  it("stops waiting when the caller goes away (the run carries on)", async () => {
    await fixtures.user({ id: "u1", balance: 10_000_000 });
    const gone = new AbortController();
    const started = Date.now();
    const waiting = createCompletion("u1", { model: "openrouter/free", messages: [{ role: "user", content: "Hi" }] }, { traceId: "t", waitMs: 30_000, pollMs: 50, signal: gone.signal });
    setTimeout(() => gone.abort(), 200);
    const result = await waiting;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.status).toBe(202);
    expect(await prisma.agentRun.findFirstOrThrow()).toMatchObject({ status: "PENDING" });
  });
});
