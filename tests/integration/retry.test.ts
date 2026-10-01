import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorResponseSchema, MessageListResponseSchema, RetryRunResponseSchema } from "#src/contracts/index.js";
import { createApp } from "#src/app.js";
import { prisma } from "#src/db/client.js";
import { loadConversation } from "#src/agent/context.js";
import { runAgentTurn } from "#src/agent/runTurn.js";
import { finalizeRun } from "#src/services/runs.js";
import { as } from "../helpers/app.js";
import { fixtures, resetDb } from "../helpers/db.js";
import { fakeModel, finished, text } from "../helpers/fakeModel.js";
import { api } from "../helpers/http.js";
import { trigger } from "../helpers/triggerMock.js";

beforeEach(resetDb);
afterEach(() => void vi.restoreAllMocks());

const HOLD = 100_000;

type Res = { status: number; body: unknown };
const created = (res: Res) => (res.body as { chat: { id: string } }).chat.id;
const sendBody = (res: Res) => res.body as { runId: string; triggerRunId: string; message: { id: string } };

async function chatWith(user = "u1") {
  return created(await as(user).post("/api/chats").send({}));
}

/** Sends a message and ends its run the given way, as the worker or a stop would. */
async function turn(chatId: string, content: string, ending: "FAILED" | "CANCELLED" | "COMPLETED", user = "u1") {
  const res = await as(user).post(`/api/chats/${chatId}/messages`).send({ content });
  expect(res.status).toBe(201);
  const { runId, message } = sendBody(res);
  const outcome =
    ending === "FAILED"
      ? { status: "FAILED" as const, errorCode: "MODEL_RATE_LIMITED", errorMessage: "The free model is busy right now. Please try again in a moment.", blocks: [{ type: "text" as const, content: "Partial" }] }
      : ending === "COMPLETED"
        ? { status: "COMPLETED" as const, blocks: [{ type: "text" as const, content: `Answer to ${content}` }] }
        : { status: "CANCELLED" as const };
  expect(await finalizeRun(runId, outcome)).toBe(true);
  return { runId, questionId: message.id };
}

const retry = (runId: string, user = "u1") => as(user).post(`/api/runs/${runId}/retry`).send();
const errorCode = (res: Res) => ErrorResponseSchema.parse(res.body).code;
const runRow = (id: string) => prisma.agentRun.findUniqueOrThrow({ where: { id } });
const held = async (user = "u1") => (await prisma.user.findUniqueOrThrow({ where: { id: user } })).held;
const listed = async (chatId: string, user = "u1") => MessageListResponseSchema.parse((await as(user).get(`/api/chats/${chatId}/messages`)).body).messages;

describe("retrying the latest turn", () => {
  it("starts a new run for the same question: 201 in the send shape, with a token, and nothing duplicated", async () => {
    const chat = await chatWith();
    const failed = await turn(chat, "Explain recursion", "FAILED");
    const dispatchedBefore = trigger.dispatches.length;

    const res = await retry(failed.runId);
    expect(res.status).toBe(201);
    const body = RetryRunResponseSchema.parse(res.body);
    expect(body.runId).not.toBe(failed.runId);
    expect(body.message).toMatchObject({ id: failed.questionId, role: "USER", content: "Explain recursion", agentRunId: body.runId });
    expect(body.chatId).toBe(chat);
    expect(body.realtimeToken).toBe(`token-for-${body.triggerRunId}`);

    const run = await runRow(body.runId);
    expect(run).toMatchObject({ status: "PENDING", triggerMessageId: failed.questionId, retryOfRunId: failed.runId, triggerRunId: body.triggerRunId });
    expect(trigger.dispatches).toHaveLength(dispatchedBefore + 1);
    expect(trigger.dispatches.at(-1)).toMatchObject({ key: `agent-run:${body.runId}`, payload: { agentRunId: body.runId, chatId: chat, assistantMessageId: run.assistantMessageId } });

    expect(await prisma.message.count({ where: { chatId: chat, role: "USER" } })).toBe(1); // the question is not asked twice
    expect(await held()).toBe(HOLD);
  });

  it("keeps the failed reply visible, with its reason, and puts the new reply after it", async () => {
    const chat = await chatWith();
    const failed = await turn(chat, "Question", "FAILED");
    const body = RetryRunResponseSchema.parse((await retry(failed.runId)).body);
    const newReply = await prisma.message.findUniqueOrThrow({ where: { id: (await runRow(body.runId)).assistantMessageId } });
    const oldReply = await prisma.message.findUniqueOrThrow({ where: { id: (await runRow(failed.runId)).assistantMessageId } });
    expect(newReply.createdAt.getTime()).toBeGreaterThan(oldReply.createdAt.getTime());

    const messages = await listed(chat);
    expect(messages.map((m) => [m.role, m.status])).toEqual([
      ["USER", "COMPLETED"],
      ["ASSISTANT", "FAILED"], // the new reply is still being written, so it is delivered by the run, not listed yet
    ]);
    expect(messages[1]).toMatchObject({ errorMessage: "The free model is busy right now. Please try again in a moment.", content: "Partial", canRetry: false });
  });

  it("works for a stopped (cancelled) turn too", async () => {
    const chat = await chatWith();
    const stopped = await turn(chat, "Question", "CANCELLED");
    expect((await retry(stopped.runId)).status).toBe(201);
  });

  it("moves the chat up, like a send", async () => {
    const chat = await chatWith();
    const failed = await turn(chat, "Question", "FAILED");
    const before = (await prisma.chat.findUniqueOrThrow({ where: { id: chat } })).lastMessageAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await retry(failed.runId);
    expect((await prisma.chat.findUniqueOrThrow({ where: { id: chat } })).lastMessageAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("answers the question with the same conversation the first attempt saw", async () => {
    const chat = await chatWith();
    await turn(chat, "First question", "COMPLETED");
    const failed = await turn(chat, "Second question", "FAILED");
    const body = RetryRunResponseSchema.parse((await retry(failed.runId)).body);
    const run = await runRow(body.runId);
    expect(await loadConversation(chat, run.triggerMessageId)).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "Answer to First question" },
      { role: "user", content: "Second question" }, // the failed reply is left out
    ]);
  });

  it("runs end to end: the worker answers the retry and the chat then reads question, failed reply, new answer", async () => {
    const chat = await chatWith();
    const failed = await turn(chat, "Say hi", "FAILED");
    const body = RetryRunResponseSchema.parse((await retry(failed.runId)).body);
    const payload = trigger.dispatches.at(-1)!.payload;

    const model = fakeModel([text("Hi!"), finished("meta/free-7b", 5, 2)]);
    const result = await runAgentTurn(payload, { stream: model.stream, emit: () => undefined, setStatus: () => undefined, triggerRunId: body.triggerRunId, signal: new AbortController().signal, flushEveryMs: 0 });
    expect(result).toBe("completed");

    const messages = await listed(chat);
    expect(messages.map((m) => [m.role, m.status, m.content])).toEqual([
      ["USER", "COMPLETED", "Say hi"],
      ["ASSISTANT", "FAILED", "Partial"],
      ["ASSISTANT", "COMPLETED", "Hi!"],
    ]);
    expect(messages.map((m) => m.canRetry)).toEqual([false, false, false]);
    expect(messages[2]?.agentRunId).toBe(body.runId);
    expect(await held()).toBe(0);
  });
});

describe("what cannot be retried", () => {
  it("a completed turn (409 RUN_NOT_RETRYABLE)", async () => {
    const chat = await chatWith();
    const done = await turn(chat, "Question", "COMPLETED");
    const res = await retry(done.runId);
    expect(res.status).toBe(409);
    expect(ErrorResponseSchema.parse(res.body)).toMatchObject({ code: "RUN_NOT_RETRYABLE", error: "Only a failed or stopped reply can be retried." });
  });

  it("a turn that is still running (409 RUN_ACTIVE)", async () => {
    const chat = await chatWith();
    const res = await as("u1").post(`/api/chats/${chat}/messages`).send({ content: "Question" });
    const retried = await retry(sendBody(res).runId);
    expect(retried.status).toBe(409);
    expect(errorCode(retried)).toBe("RUN_ACTIVE");
  });

  it("an older turn, once a newer one exists (409 RUN_NOT_RETRYABLE), so the chat always reads in order", async () => {
    const chat = await chatWith();
    const older = await turn(chat, "Old question", "FAILED");
    await turn(chat, "New question", "COMPLETED");
    const res = await retry(older.runId);
    expect(res.status).toBe(409);
    expect(ErrorResponseSchema.parse(res.body)).toMatchObject({ code: "RUN_NOT_RETRYABLE", error: "Only the latest message can be retried." });
  });

  it("another user's run, or a run that does not exist (404, nothing leaks)", async () => {
    const chat = await chatWith("u1");
    const failed = await turn(chat, "Mine", "FAILED");
    for (const [user, id] of [["u2", failed.runId], ["u1", "nosuchrun"], ["u1", "bad id!"]] as const) {
      const res = await retry(id, user);
      expect(res.status).toBe(404);
      expect(errorCode(res)).toBe("NOT_FOUND");
    }
    expect(await prisma.agentRun.count()).toBe(1);
  });

  it("without a token (401)", async () => {
    const chat = await chatWith();
    const failed = await turn(chat, "Question", "FAILED");
    expect((await api(createApp()).post(`/api/runs/${failed.runId}/retry`)).status).toBe(401);
  });

  it("when the user has run out of credits (402), writing nothing", async () => {
    const chat = await chatWith();
    const failed = await turn(chat, "Question", "FAILED");
    await prisma.user.update({ where: { id: "u1" }, data: { balance: HOLD - 1 } });
    const before = { messages: await prisma.message.count(), runs: await prisma.agentRun.count() };
    const res = await retry(failed.runId);
    expect(res.status).toBe(402);
    expect(errorCode(res)).toBe("INSUFFICIENT_CREDITS");
    expect({ messages: await prisma.message.count(), runs: await prisma.agentRun.count() }).toEqual(before);
  });
});

describe("double clicks and races", () => {
  it("gives back the same retry when it is asked for again (200), starting nothing new", async () => {
    const chat = await chatWith();
    const failed = await turn(chat, "Question", "FAILED");
    const first = RetryRunResponseSchema.parse((await retry(failed.runId)).body);
    const again = await retry(failed.runId);
    expect(again.status).toBe(200);
    expect(RetryRunResponseSchema.parse(again.body)).toMatchObject({ runId: first.runId, triggerRunId: first.triggerRunId });
    expect(await prisma.agentRun.count({ where: { retryOfRunId: failed.runId } })).toBe(1);
    expect(await held()).toBe(HOLD);
  });

  it("starts exactly one retry when many arrive at once, and every caller gets that one", async () => {
    const chat = await chatWith();
    const failed = await turn(chat, "Question", "FAILED");
    const results = await Promise.all(Array.from({ length: 6 }, () => retry(failed.runId)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    const runIds = new Set(results.map((r) => RetryRunResponseSchema.parse(r.body).runId));
    expect(runIds.size).toBe(1);
    expect(await prisma.agentRun.count({ where: { retryOfRunId: failed.runId } })).toBe(1);
    expect(await prisma.creditLedger.count({ where: { type: "HOLD" } })).toBe(2); // the original send and the one retry
    expect(await held()).toBe(HOLD);
  });

  it("lets only one win when a retry and a new message race, and never runs two at once", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const chat = await chatWith();
      const failed = await turn(chat, "Question", "FAILED");
      const [retried, sent] = await Promise.all([retry(failed.runId), as("u1").post(`/api/chats/${chat}/messages`).send({ content: "Something else" })]);
      expect([retried.status, sent.status].sort()).toEqual(expect.arrayContaining([201]));
      expect([retried.status, sent.status].filter((s) => s === 201)).toHaveLength(1);
      expect(await prisma.agentRun.count({ where: { chatId: chat, status: { in: ["PENDING", "RUNNING"] } } })).toBe(1);
      expect(await held()).toBe(HOLD);
    }
  });

  it("can retry the retry once that fails too, and each retry points at the one before it", async () => {
    const chat = await chatWith();
    const failed = await turn(chat, "Question", "FAILED");
    const second = RetryRunResponseSchema.parse((await retry(failed.runId)).body);
    await finalizeRun(second.runId, { status: "FAILED", errorCode: "MODEL_UNAVAILABLE", errorMessage: "The assistant is unavailable right now. Please try again shortly." });

    expect((await listed(chat)).map((m) => m.canRetry)).toEqual([false, false, true]); // only the newest failed reply
    const third = await retry(second.runId);
    expect(third.status).toBe(201);
    expect(await runRow(RetryRunResponseSchema.parse(third.body).runId)).toMatchObject({ retryOfRunId: second.runId, triggerMessageId: failed.questionId });
    expect((await retry(failed.runId)).status).toBe(200); // the first failure was already retried: same answer as before
  });
});

describe("a chat deleted at the same moment", () => {
  it("answers 404 and writes nothing, even if the delete lands between the checks and the write", async () => {
    const chat = await chatWith();
    const failed = await turn(chat, "Question", "FAILED");
    const real = prisma.$transaction.bind(prisma) as (fn: unknown) => Promise<unknown>;
    vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (fn: unknown) => {
      await prisma.chat.delete({ where: { id: chat } });
      return real(fn);
    }));
    const res = await retry(failed.runId);
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe("NOT_FOUND");
    expect(await prisma.agentRun.count()).toBe(0);
    expect(await held()).toBe(0);
  });
});

describe("when the agent cannot be started", () => {
  it("undoes the retry (503): the new reply and run are gone, the credits are back, the question and failed reply stay, and it can be retried again", async () => {
    const chat = await chatWith();
    const failed = await turn(chat, "Question", "FAILED");
    trigger.dispatchError = new Error("Trigger.dev is down");

    const res = await retry(failed.runId);
    expect(res.status).toBe(503);
    expect(errorCode(res)).toBe("SERVICE_UNAVAILABLE");
    expect(await prisma.agentRun.count({ where: { retryOfRunId: failed.runId } })).toBe(0);
    expect(await prisma.message.count({ where: { chatId: chat } })).toBe(2); // the question and the failed reply
    expect(await held()).toBe(0);
    expect((await listed(chat)).at(-1)).toMatchObject({ status: "FAILED", canRetry: true });

    trigger.dispatchError = null;
    expect((await retry(failed.runId)).status).toBe(201);
  });
});

describe("canRetry in the message list", () => {
  it("is true only on the latest reply, and only when it failed or was stopped", async () => {
    const chat = await chatWith();
    await turn(chat, "One", "FAILED");
    await turn(chat, "Two", "COMPLETED");
    let messages = await listed(chat);
    expect(messages.map((m) => [m.role, m.status, m.canRetry])).toEqual([
      ["USER", "COMPLETED", false],
      ["ASSISTANT", "FAILED", false], // an older failure: not retryable any more
      ["USER", "COMPLETED", false],
      ["ASSISTANT", "COMPLETED", false],
    ]);

    await turn(chat, "Three", "CANCELLED");
    messages = await listed(chat);
    expect(messages.at(-1)).toMatchObject({ status: "CANCELLED", canRetry: true });
    expect(messages.filter((m) => m.canRetry)).toHaveLength(1);
  });

  it("is false everywhere while a run is going", async () => {
    const chat = await chatWith();
    await turn(chat, "One", "FAILED");
    await as("u1").post(`/api/chats/${chat}/messages`).send({ content: "Two" });
    expect((await listed(chat)).some((m) => m.canRetry)).toBe(false);
  });

  it("is true on the latest reply even when it is on an older page (it is the chat's latest turn that counts)", async () => {
    const user = await fixtures.user({ id: "u3" });
    const chatId = (await fixtures.chat(user.id)).id;
    const res = await as("u3").post(`/api/chats/${chatId}/messages`).send({ content: "Only question" });
    await finalizeRun(sendBody(res).runId, { status: "FAILED", errorCode: "MODEL_EMPTY", errorMessage: "The assistant didn't return an answer. Please try again." });
    const page = MessageListResponseSchema.parse((await as("u3").get(`/api/chats/${chatId}/messages?limit=1`)).body);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({ role: "ASSISTANT", canRetry: true });
  });
});

describe("rate limiting", () => {
  it("counts retries and sends against the same allowance", async () => {
    const tight = createApp({ rateLimits: { authenticated: 1_000, anonymous: 1_000 }, sendLimit: 2 });
    const auth = { Authorization: "Bearer test:u9" };
    const chat = created(await api(tight).post("/api/chats").set(auth).send({}));
    const res = await api(tight).post(`/api/chats/${chat}/messages`).set(auth).send({ content: "Question" });
    await finalizeRun(sendBody(res).runId, { status: "FAILED", errorCode: "MODEL_EMPTY" });
    expect((await api(tight).post(`/api/runs/${sendBody(res).runId}/retry`).set(auth)).status).toBe(201);
    const third = await api(tight).post(`/api/runs/${sendBody(res).runId}/retry`).set(auth);
    expect(third.status).toBe(429);
    expect(errorCode(third)).toBe("RATE_LIMITED");
  });
});
