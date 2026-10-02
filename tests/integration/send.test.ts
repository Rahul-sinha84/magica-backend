import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorResponseSchema, SendMessageResponseSchema } from "#src/contracts/index.js";
import { prisma, Prisma } from "#src/db/client.js";
import { sendMessage } from "#src/services/turns.js";
import { finalizeRun } from "#src/services/runs.js";
import { as } from "../helpers/app.js";
import { activeTurn, fixtures, resetDb } from "../helpers/db.js";
import { trigger, triggerModule } from "../helpers/triggerMock.js";
import { START_TIMEOUT_MS } from "#src/services/reconcile.js";
import { createApp } from "#src/app.js";
import { api } from "../helpers/http.js";

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_chat_update ON "Chat"`); // in case an earlier run was interrupted
  await resetDb();
});

const HOLD = 100_000;
const START = 30_000_000;

interface SendBody {
  message: { id: string; chatId: string; role: string; status: string; content: string; agentRunId: string | null; clientMessageId: string | null; createdAt: string };
  chatId: string;
  runId: string;
  triggerRunId: string;
  realtimeToken: string;
  realtimeTokenExpiresAt: string;
}
type Res = { body: unknown; status: number; headers: Record<string, string> };
const sent = (res: Res) => res.body as SendBody;
const createdId = (res: Res) => (res.body as { chat: { id: string } }).chat.id;

const newChat = async (user: string, title?: string) => createdId(await as(user).post("/api/chats").send(title ? { title } : {}));
const send = (user: string, chatId: string, body: unknown) => as(user).post(`/api/chats/${chatId}/messages`).send(body as object);
const uuid = () => crypto.randomUUID();
const credits = async (user: string) => (await as(user).get("/api/credits")).body as { balance: number; held: number };
const counts = async () => ({
  messages: await prisma.message.count(),
  runs: await prisma.agentRun.count(),
  dispatches: trigger.dispatches.length,
});
const nothingHappened = async (user: string, before: Awaited<ReturnType<typeof counts>>) => {
  expect(await counts()).toEqual(before);
  expect((await credits(user)).held).toBe(0);
};
const titleOf = async (chatId: string) => (await prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).title;

describe("a successful send", () => {
  it("answers 201 in the contract shape, with a run, a realtime token and the user's message", async () => {
    const chat = await newChat("u1");
    const res = await send("u1", chat, { content: "Hello there", clientMessageId: uuid() });
    expect(res.status).toBe(201);
    const body = SendMessageResponseSchema.parse(res.body);
    expect(body).toMatchObject({ chatId: chat, message: { role: "USER", status: "COMPLETED", content: "Hello there", chatId: chat } });
    expect(body.message.agentRunId).toBe(body.runId);
    expect(body.realtimeToken).toBe(`token-for-${body.triggerRunId}`);
    expect(new Date(body.realtimeTokenExpiresAt).getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
  });

  it("writes the user message, a streaming placeholder for the reply, and a pending run, all in the same chat", async () => {
    const chat = await newChat("u1");
    const body = sent(await send("u1", chat, { content: "Hi" }));
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: body.runId }, include: { triggerMessage: true, assistantMessage: true } });
    expect(run).toMatchObject({ chatId: chat, userId: "u1", status: "PENDING", triggerRunId: body.triggerRunId, startedAt: null, completedAt: null });
    expect(run.triggerMessage).toMatchObject({ id: body.message.id, role: "USER", status: "COMPLETED", chatId: chat });
    expect(run.assistantMessage).toMatchObject({ role: "ASSISTANT", status: "STREAMING", content: null, contentBlocks: [], chatId: chat });
  });

  it("puts the reply placeholder strictly after the question, so history always reads question then answer", async () => {
    const chat = await newChat("u1");
    const body = sent(await send("u1", chat, { content: "Hi" }));
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: body.runId }, include: { triggerMessage: true, assistantMessage: true } });
    expect(run.assistantMessage.createdAt.getTime()).toBeGreaterThan(run.triggerMessage.createdAt.getTime());
  });

  it("holds credits for the run and shows it in the balance", async () => {
    const chat = await newChat("u1");
    const body = sent(await send("u1", chat, { content: "Hi" }));
    expect(await credits("u1")).toEqual({ balance: START, held: HOLD });
    const entries = await prisma.creditLedger.findMany({ where: { type: "HOLD" } });
    expect(entries).toMatchObject([{ userId: "u1", amount: HOLD, agentRunId: body.runId, idempotencyKey: `hold:${body.runId}` }]);
  });

  it("hands the agent only ids and the trace id, with an idempotency key tied to the run", async () => {
    const chat = await newChat("u1");
    const res = await send("u1", chat, { content: "Hi" });
    const body = sent(res);
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: body.runId } });
    expect(trigger.dispatches).toHaveLength(1);
    expect(trigger.dispatches[0]).toMatchObject({
      key: `agent-run:${body.runId}`,
      payload: { agentRunId: body.runId, chatId: chat, userId: "u1", assistantMessageId: run.assistantMessageId, traceId: res.headers["x-trace-id"] },
    });
    expect(run.traceId).toBe(res.headers["x-trace-id"]); // the same id is in the logs, the run row and the task
    expect(JSON.stringify(trigger.dispatches[0]?.payload)).not.toContain("Hi"); // the message text is read from the database, not copied
  });

  it("stores the text exactly as typed and returns the client's message id", async () => {
    const chat = await newChat("u1");
    const text = "  def f():\n      return 1\n\n日本語 \u{1F642}\t";
    const id = uuid();
    const body = sent(await send("u1", chat, { content: text, clientMessageId: id }));
    expect(body.message).toMatchObject({ content: text, clientMessageId: id });
    expect((await prisma.message.findUniqueOrThrow({ where: { id: body.message.id } })).content).toBe(text);
  });

  it("moves the chat to the top of the list", async () => {
    const older = await newChat("u1", "Older");
    const newer = await newChat("u1", "Newer");
    await send("u1", older, { content: "bump" });
    const ids = ((await as("u1").get("/api/chats")).body as { chats: { id: string }[] }).chats.map((c) => c.id);
    expect(ids).toEqual([older, newer]);
  });

  it("links the run to the runs' chat and user, never to anything else", async () => {
    const chat = await newChat("u1");
    const other = await newChat("u1");
    const body = sent(await send("u1", chat, { content: "Hi" }));
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: body.runId }, include: { triggerMessage: true, assistantMessage: true } });
    expect([run.chatId, run.triggerMessage.chatId, run.assistantMessage.chatId]).toEqual([chat, chat, chat]);
    expect(await prisma.agentRun.count({ where: { chatId: other } })).toBe(0);
  });
});

describe("naming the chat from its first message", () => {
  it("uses the first message, trimmed and on one line", async () => {
    const chat = await newChat("u1");
    await send("u1", chat, { content: "  Plan a trip\n\n  to   Lisbon  " });
    expect(await titleOf(chat)).toBe("Plan a trip to Lisbon");
  });

  it("cuts a long message at 50 characters with an ellipsis, never splitting an emoji", async () => {
    const chat = await newChat("u1");
    await send("u1", chat, { content: "\u{1F642}".repeat(80) });
    const title = await titleOf(chat);
    expect(Array.from(title)).toHaveLength(51);
    expect(title.endsWith("…")).toBe(true);
    expect(title.slice(0, -1)).toBe("\u{1F642}".repeat(50));
  });

  it("leaves a chat alone once it has a name, and never overwrites one the user chose", async () => {
    const named = await newChat("u1", "My own title");
    await send("u1", named, { content: "something else entirely" });
    expect(await titleOf(named)).toBe("My own title");

    const auto = await newChat("u1");
    const first = sent(await send("u1", auto, { content: "First message" }));
    await finalizeRun(first.runId, { status: "COMPLETED", blocks: [{ type: "text", content: "ok" }] });
    await send("u1", auto, { content: "Second message" });
    expect(await titleOf(auto)).toBe("First message");
  });

  it("keeps 'New chat' when nothing readable can be made from the message", async () => {
    const chat = await newChat("u1");
    await send("u1", chat, { content: "​​" }); // zero-width characters only: allowed as a message, useless as a title
    expect(await titleOf(chat)).toBe("New chat");
  });

  it("does not need an exact match in case or spacing to count as unnamed (only the default name is replaced)", async () => {
    const chat = await newChat("u1", "new chat"); // a user's own title that merely looks similar
    await send("u1", chat, { content: "hello" });
    expect(await titleOf(chat)).toBe("new chat");
  });
});

describe("what a send refuses, and leaves untouched", () => {
  const cases: [string, unknown][] = [
    ["blank content", { content: "   \n\t" }],
    ["empty content", { content: "" }],
    ["content over 32,000 characters", { content: "x".repeat(32_001) }],
    ["NUL in the content", { content: "a\u0000b" }],
    ["content of the wrong type", { content: 42 }],
    ["an unknown field", { content: "hi", extra: true }],
    ["trying to choose the owner", { content: "hi", userId: "someone-else" }],
    ["trying to choose the role", { content: "hi", role: "ASSISTANT" }],
    ["a client id that is not a UUID", { content: "hi", clientMessageId: "abc" }],
    ["attachments (not supported yet)", { content: "hi", attachments: ["https://cdn.example.com/a.png"] }],
    ["too many attachments", { content: "hi", attachments: Array(11).fill("https://cdn.example.com/a.png") }],
    ["an array body", [{ content: "hi" }]],
  ];

  it.each(cases)("%s: 400, nothing written, no credits held, nothing dispatched", async (_label, body) => {
    const chat = await newChat("u1");
    const before = await counts();
    const res = await send("u1", chat, body);
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("VALIDATION_FAILED");
    await nothingHappened("u1", before);
  });

  it("refuses a raw link as an attachment (files come from the user's library), changing nothing", async () => {
    const chat = await newChat("u1");
    const before = await counts();
    const res = await send("u1", chat, { content: "hi", attachments: ["https://cdn.example.com/a.png"] });
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("VALIDATION_FAILED");
    await nothingHappened("u1", before);
  });

  it("rejects a request with no body, or a body of another content type", async () => {
    const chat = await newChat("u1");
    const before = await counts();
    expect((await as("u1").post(`/api/chats/${chat}/messages`)).status).toBe(400);
    expect((await as("u1").post(`/api/chats/${chat}/messages`).type("text/plain").send("hello")).status).toBe(400);
    await nothingHappened("u1", before);
  });

  it("answers 404, writing nothing, for another user's chat, a missing chat, or an impossible id", async () => {
    const theirs = await newChat("owner");
    await as("u1").get("/api/credits");
    const before = await counts();
    for (const id of [theirs, "doesnotexist", "%00", "x".repeat(65), "..%2F..%2Fetc"]) {
      const res = await send("u1", id, { content: "hi" });
      expect(res.status, id).toBe(404);
      expect(ErrorResponseSchema.parse(res.body).code).toBe("NOT_FOUND");
    }
    await nothingHappened("u1", before);
    expect(await credits("owner")).toEqual({ balance: START, held: 0 });
  });

  it("needs a signed-in user", async () => {
    const chat = await newChat("u1");
    const res = await api(createApp()).post(`/api/chats/${chat}/messages`).send({ content: "hi" });
    expect(res.status).toBe(401);
  });
});

describe("credits", () => {
  it("refuses with 402 when the balance cannot cover the hold, writing nothing", async () => {
    const chat = await newChat("u1");
    await prisma.user.update({ where: { id: "u1" }, data: { balance: HOLD - 1 } });
    const before = await counts();
    const res = await send("u1", chat, { content: "hi" });
    expect(res.status).toBe(402);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("INSUFFICIENT_CREDITS");
    expect(await counts()).toEqual(before);
    expect(await prisma.creditLedger.count({ where: { type: "HOLD" } })).toBe(0);
    expect(await titleOf(chat)).toBe("New chat"); // not even the chat's name changed
  });

  it("accepts a balance that exactly covers the hold", async () => {
    const chat = await newChat("u1");
    await prisma.user.update({ where: { id: "u1" }, data: { balance: HOLD } });
    expect((await send("u1", chat, { content: "hi" })).status).toBe(201);
    expect(await credits("u1")).toEqual({ balance: HOLD, held: HOLD });
  });

  it("counts what other runs already hold", async () => {
    const [a, b] = [await newChat("u1"), await newChat("u1")];
    await prisma.user.update({ where: { id: "u1" }, data: { balance: HOLD + HOLD / 2 } });
    expect((await send("u1", a, { content: "one" })).status).toBe(201);
    expect((await send("u1", b, { content: "two" })).status).toBe(402); // only half a hold is left
  });

  it("never lets simultaneous sends in different chats spend more than is available", async () => {
    const chats = await Promise.all(Array.from({ length: 6 }, () => newChat("u1")));
    await prisma.user.update({ where: { id: "u1" }, data: { balance: HOLD * 2 } });
    const results = await Promise.all(chats.map((chat) => send("u1", chat, { content: "go" })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 402, 402, 402, 402]);
    expect(await credits("u1")).toEqual({ balance: HOLD * 2, held: HOLD * 2 });
    expect(await prisma.agentRun.count()).toBe(2);
    expect(trigger.dispatches).toHaveLength(2);
  });
});

describe("credits held by runs that are really dead", () => {
  // the user can afford exactly one run, and one of their other chats holds that credit
  async function poorUserWithARunElsewhere(run: { triggerRunId: string; quietMs: number; ageMs: number; status?: "PENDING" | "RUNNING" }) {
    const user = await fixtures.user({ id: "u1", balance: HOLD });
    const busy = await fixtures.chat(user.id);
    const target = await fixtures.chat(user.id);
    const turn = await activeTurn(busy.id, user.id, run);
    return { target, turn };
  }

  it("frees them so a new send in another chat can go ahead", async () => {
    const { target, turn } = await poorUserWithARunElsewhere({ triggerRunId: "run_dead", quietMs: 60_000, ageMs: 120_000 });
    trigger.statuses.set("run_dead", "CRASHED");
    const res = await send("u1", target.id, { content: "now I can" });
    expect(res.status).toBe(201);
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: turn.run.id } })).toMatchObject({ status: "FAILED", errorCode: "AGENT_CRASHED" });
    expect(await credits("u1")).toEqual({ balance: HOLD, held: HOLD }); // only the new run holds credits now
  });

  it("also frees credits held by a run nobody ever picked up", async () => {
    const { target } = await poorUserWithARunElsewhere({ triggerRunId: "run_never_started", quietMs: START_TIMEOUT_MS, ageMs: START_TIMEOUT_MS + 5_000, status: "PENDING" });
    trigger.statuses.set("run_never_started", "PENDING_VERSION");
    expect((await send("u1", target.id, { content: "there is room again" })).status).toBe(201);
  });

  it("does not take credits from a run that is only waiting in the queue", async () => {
    const { target, turn } = await poorUserWithARunElsewhere({ triggerRunId: "run_waiting", quietMs: START_TIMEOUT_MS, ageMs: START_TIMEOUT_MS + 5_000, status: "PENDING" });
    trigger.statuses.set("run_waiting", "QUEUED");
    const res = await send("u1", target.id, { content: "no room yet" });
    expect(res.status).toBe(402);
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: turn.run.id } })).toMatchObject({ status: "PENDING" });
  });

  it("does not take credits from a run that is alive", async () => {
    const { target, turn } = await poorUserWithARunElsewhere({ triggerRunId: "run_alive", quietMs: 60_000, ageMs: 120_000 });
    trigger.statuses.set("run_alive", "EXECUTING");
    const res = await send("u1", target.id, { content: "no room" });
    expect(res.status).toBe(402);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("INSUFFICIENT_CREDITS");
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: turn.run.id } })).toMatchObject({ status: "RUNNING" });
    expect((await credits("u1")).held).toBe(HOLD);
  });

  it("does not guess when Trigger.dev cannot say what happened to a run", async () => {
    const { target, turn } = await poorUserWithARunElsewhere({ triggerRunId: "run_unknown", quietMs: 60_000, ageMs: 120_000 });
    trigger.statuses.set("run_unknown", null);
    expect((await send("u1", target.id, { content: "no room" })).status).toBe(402);
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: turn.run.id } })).toMatchObject({ status: "RUNNING" });
  });

  it("leaves a run that has only just started alone, without even asking Trigger.dev", async () => {
    const { target, turn } = await poorUserWithARunElsewhere({ triggerRunId: "run_new", quietMs: 500, ageMs: 2_000 });
    expect((await send("u1", target.id, { content: "no room" })).status).toBe(402);
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: turn.run.id } })).toMatchObject({ status: "RUNNING" });
    expect(trigger.statusLookups).toHaveLength(0);
  });

  it("never touches another user's runs", async () => {
    const other = await fixtures.user({ id: "someone-else", balance: 1_000_000 });
    const theirChat = await fixtures.chat(other.id);
    const theirs = await activeTurn(theirChat.id, other.id, { triggerRunId: "run_theirs", quietMs: 60_000, ageMs: 120_000 });
    trigger.statuses.set("run_theirs", "CRASHED");
    const { target } = await poorUserWithARunElsewhere({ triggerRunId: "run_mine", quietMs: 60_000, ageMs: 120_000 });
    trigger.statuses.set("run_mine", "EXECUTING");
    expect((await send("u1", target.id, { content: "no room" })).status).toBe(402);
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: theirs.run.id } })).toMatchObject({ status: "RUNNING" });
  });

  it("refuses a balance that is simply too low straight away, without looking for runs to clean up", async () => {
    const user = await fixtures.user({ id: "u1", balance: HOLD - 1 });
    const chat = await fixtures.chat(user.id);
    const res = await send("u1", chat.id, { content: "never affordable" });
    expect(res.status).toBe(402);
    expect(trigger.statusLookups).toHaveLength(0);
    expect(await prisma.message.count()).toBe(0);
  });
});

describe("one active run per chat", () => {
  it("answers 409 to a second send while the first is running, changing nothing", async () => {
    const chat = await newChat("u1");
    expect((await send("u1", chat, { content: "first" })).status).toBe(201);
    const before = await counts();
    const heldBefore = (await credits("u1")).held;

    const res = await send("u1", chat, { content: "second" });
    expect(res.status).toBe(409);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("RUN_ACTIVE");
    expect(await counts()).toEqual(before);
    expect((await credits("u1")).held).toBe(heldBefore);
  });

  it("lets exactly one of many simultaneous sends to one chat through", async () => {
    const chat = await newChat("u1");
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => send("u1", chat, { content: `go ${i}`, clientMessageId: uuid() })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await prisma.agentRun.count({ where: { chatId: chat } })).toBe(1);
    expect(await prisma.message.count({ where: { chatId: chat } })).toBe(2);
    expect(await credits("u1")).toEqual({ balance: START, held: HOLD });
    expect(trigger.dispatches).toHaveLength(1);
  });

  it("accepts the next send as soon as the previous run has ended, however it ended", async () => {
    const chat = await newChat("u1");
    for (const outcome of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
      const body = sent(await send("u1", chat, { content: `after ${outcome}` }));
      await finalizeRun(body.runId, { status: outcome, ...(outcome === "COMPLETED" && { blocks: [{ type: "text", content: "done" }] }) });
    }
    expect(await prisma.agentRun.count({ where: { chatId: chat } })).toBe(3);
    expect((await credits("u1")).held).toBe(0);
  });

  it("clears a run whose worker is gone instead of locking the chat", async () => {
    const chat = await newChat("u1");
    const first = sent(await send("u1", chat, { content: "first" }));
    trigger.statuses.set(first.triggerRunId, "CRASHED");

    const second = await send("u1", chat, { content: "second" });
    expect(second.status).toBe(201);
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: first.runId } })).toMatchObject({ status: "FAILED", errorCode: "AGENT_CRASHED" });
    expect((await credits("u1")).held).toBe(HOLD); // the dead run's hold was returned; only the new one is held
  });

  it("still answers 409 when Trigger.dev says the run is alive", async () => {
    const chat = await newChat("u1");
    const first = sent(await send("u1", chat, { content: "first" }));
    trigger.statuses.set(first.triggerRunId, "EXECUTING");
    expect((await send("u1", chat, { content: "second" })).status).toBe(409);
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: first.runId } })).toMatchObject({ status: "PENDING" });
  });

  it("still answers 409 when Trigger.dev cannot be asked, rather than guessing", async () => {
    const chat = await newChat("u1");
    const first = sent(await send("u1", chat, { content: "first" }));
    trigger.statuses.set(first.triggerRunId, null);
    expect((await send("u1", chat, { content: "second" })).status).toBe(409);
  });

  it("clears a run that nobody ever picked up, instead of making the user wait out the time limit", async () => {
    const user = await fixtures.user({ id: "u1", balance: START });
    const chat = await fixtures.chat(user.id);
    const stuck = await activeTurn(chat.id, user.id, { status: "PENDING", triggerRunId: "run_never_started", ageMs: START_TIMEOUT_MS + 5_000, quietMs: START_TIMEOUT_MS });
    trigger.statuses.set("run_never_started", "PENDING_VERSION");

    expect((await send("u1", chat.id, { content: "now?" })).status).toBe(201);
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: stuck.run.id } })).toMatchObject({ status: "FAILED", errorCode: "AGENT_NOT_STARTED" });
  });

  it("lets different chats run at once", async () => {
    const [a, b] = [await newChat("u1"), await newChat("u1")];
    expect((await send("u1", a, { content: "one" })).status).toBe(201);
    expect((await send("u1", b, { content: "two" })).status).toBe(201);
    expect((await credits("u1")).held).toBe(HOLD * 2);
  });
});

describe("sending the same message twice (clientMessageId)", () => {
  it("returns the same turn, with a fresh token, and does no second piece of work", async () => {
    const chat = await newChat("u1");
    const clientMessageId = uuid();
    const first = await send("u1", chat, { content: "Once", clientMessageId });
    const again = await send("u1", chat, { content: "Once", clientMessageId });

    expect([first.status, again.status]).toEqual([201, 200]);
    expect(sent(again)).toMatchObject({ runId: sent(first).runId, triggerRunId: sent(first).triggerRunId, message: { id: sent(first).message.id } });
    expect(SendMessageResponseSchema.safeParse(again.body).success).toBe(true);
    expect(trigger.dispatches).toHaveLength(1);
    expect(await prisma.message.count()).toBe(2);
    expect(await credits("u1")).toEqual({ balance: START, held: HOLD });
  });

  it("still answers the replay after the run has finished", async () => {
    const chat = await newChat("u1");
    const clientMessageId = uuid();
    const first = sent(await send("u1", chat, { content: "Done soon", clientMessageId }));
    await finalizeRun(first.runId, { status: "COMPLETED", blocks: [{ type: "text", content: "ok" }] });

    const again = await send("u1", chat, { content: "Done soon", clientMessageId });
    expect(again.status).toBe(200);
    expect(sent(again).runId).toBe(first.runId);
    expect(await prisma.agentRun.count()).toBe(1);
    expect((await credits("u1")).held).toBe(0); // not held a second time
  });

  it("collapses six simultaneous copies into one turn that every caller receives", async () => {
    const chat = await newChat("u1");
    const clientMessageId = uuid();
    const results = await Promise.all(Array.from({ length: 6 }, () => send("u1", chat, { content: "Race", clientMessageId })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => sent(r).runId)).size).toBe(1);
    expect(new Set(results.map((r) => sent(r).message.id)).size).toBe(1);
    expect(new Set(results.map((r) => sent(r).triggerRunId)).size).toBe(1);
    expect(trigger.dispatches).toHaveLength(1);
    expect(await credits("u1")).toEqual({ balance: START, held: HOLD });
  });

  it("accepts a replay of a message containing a lone half of an emoji (the database stores it as a replacement character)", async () => {
    const chat = await newChat("u1");
    const id = uuid();
    const raw = (clientMessageId: string) => as("u1").post(`/api/chats/${chat}/messages`).set("Content-Type", "application/json").send(`{"content":"before \\ud83d after","clientMessageId":"${clientMessageId}"}`);
    const first = await raw(id);
    expect(first.status).toBe(201);
    expect((await prisma.message.findFirstOrThrow({ where: { clientMessageId: id } })).content).toBe("before \ufffd after");
    const again = await raw(id);
    expect(again.status).toBe(200);
    expect(sent(again).runId).toBe(sent(first).runId);
  });

  it("treats the same id in different case as the same message", async () => {
    const chat = await newChat("u1");
    const id = uuid();
    await send("u1", chat, { content: "Case", clientMessageId: id });
    const again = await send("u1", chat, { content: "Case", clientMessageId: id.toUpperCase() });
    expect(again.status).toBe(200);
    expect(await prisma.agentRun.count()).toBe(1);
  });

  it("refuses the same id for a different message, rather than quietly answering with the old one", async () => {
    const chat = await newChat("u1");
    const clientMessageId = uuid();
    await send("u1", chat, { content: "Original", clientMessageId });
    const res = await send("u1", chat, { content: "Different", clientMessageId });
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body).error).toMatch(/already used for a different message/i);
    expect(await prisma.message.count()).toBe(2);
  });

  it("treats the same id in another chat as a new message", async () => {
    const [a, b] = [await newChat("u1"), await newChat("u1")];
    const clientMessageId = uuid();
    expect((await send("u1", a, { content: "Same", clientMessageId })).status).toBe(201);
    expect((await send("u1", b, { content: "Same", clientMessageId })).status).toBe(201);
    expect(trigger.dispatches).toHaveLength(2);
  });

  it("does not let someone else's chat be probed with a known id", async () => {
    const theirs = await newChat("owner");
    const clientMessageId = uuid();
    await send("owner", theirs, { content: "Secret", clientMessageId });
    const res = await send("intruder", theirs, { content: "Secret", clientMessageId });
    expect(res.status).toBe(404);
  });

  it("makes a send without a client id a new turn every time", async () => {
    const chat = await newChat("u1");
    const first = sent(await send("u1", chat, { content: "Again" }));
    await finalizeRun(first.runId, { status: "COMPLETED", blocks: [{ type: "text", content: "ok" }] });
    const second = sent(await send("u1", chat, { content: "Again" }));
    expect(second.runId).not.toBe(first.runId);
  });
});

describe("when the agent cannot be started", () => {
  async function expectUndone(user: string, chat: string, before: Awaited<ReturnType<typeof counts>>, lastMessageAt: Date) {
    expect(await prisma.message.count()).toBe(before.messages);
    expect(await prisma.agentRun.count()).toBe(before.runs);
    expect(await credits(user)).toEqual({ balance: START, held: 0 });
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: chat } })).toMatchObject({ title: "New chat", lastMessageAt });
    const ledger = await prisma.creditLedger.findMany({ where: { type: { in: ["HOLD", "RELEASE"] } }, orderBy: { createdAt: "asc" } });
    expect(ledger.reduce((sum, row) => sum + row.amount, 0)).toBe(0); // the audit trail shows the hold and its release, netting to nothing
    expect(ledger.every((row) => row.agentRunId === null)).toBe(true);
  }

  it("answers 503 and undoes the whole send", async () => {
    const chat = await newChat("u1");
    const { lastMessageAt } = await prisma.chat.findUniqueOrThrow({ where: { id: chat } });
    const before = { messages: 0, runs: 0, dispatches: 0 };
    trigger.dispatchError = new Error("Trigger.dev is down");

    const res = await send("u1", chat, { content: "Will fail" });
    expect(res.status).toBe(503);
    expect(ErrorResponseSchema.parse(res.body)).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(JSON.stringify(res.body)).not.toContain("Trigger.dev is down");
    await expectUndone("u1", chat, before, lastMessageAt);
  });

  it("lets the same message be sent again once Trigger.dev is back, and the chat was never locked", async () => {
    const chat = await newChat("u1");
    const clientMessageId = uuid();
    trigger.dispatchError = new Error("down");
    expect((await send("u1", chat, { content: "Retry me", clientMessageId })).status).toBe(503);

    trigger.dispatchError = null;
    const retry = await send("u1", chat, { content: "Retry me", clientMessageId });
    expect(retry.status).toBe(201);
    expect(await prisma.message.count()).toBe(2);
    expect(await credits("u1")).toEqual({ balance: START, held: HOLD });
  });

  it("undoes the send even when Trigger.dev may have accepted the run before failing (the outcome is unknowable)", async () => {
    const chat = await newChat("u1");
    const { lastMessageAt } = await prisma.chat.findUniqueOrThrow({ where: { id: chat } });
    trigger.dispatchError = new Error("connection reset after the request was sent");
    trigger.acceptThenFail = true;

    expect((await send("u1", chat, { content: "Maybe started" })).status).toBe(503);
    expect(trigger.dispatches).toHaveLength(1); // the orphan exists on Trigger.dev's side; the task exits when it finds no run
    await expectUndone("u1", chat, { messages: 0, runs: 0, dispatches: 1 }, lastMessageAt);
  });

  it("stops waiting for a dispatch that never answers", async () => {
    const chat = await newChat("u1");
    const { lastMessageAt } = await prisma.chat.findUniqueOrThrow({ where: { id: chat } });
    trigger.dispatchHangs = true;
    const started = Date.now();
    await expect(
      sendMessage({ userId: "u1", chatId: chat, body: { content: "Hangs", attachments: [] }, traceId: "t" }, { dispatchTimeoutMs: 150 }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(Date.now() - started).toBeLessThan(2_000);
    await expectUndone("u1", chat, { messages: 0, runs: 0, dispatches: 0 }, lastMessageAt);
  });

  it("puts the chat's name back if the failed send had given it one", async () => {
    const chat = await newChat("u1");
    trigger.dispatchError = new Error("down");
    await send("u1", chat, { content: "A title that must not stick" });
    expect(await titleOf(chat)).toBe("New chat");
  });

  it("leaves a turn alone if the agent had actually started by the time the undo ran", async () => {
    const chat = await newChat("u1");
    // the agent starts (and finishes) between the failed dispatch and the undo
    triggerModule.dispatchAgentTurn.mockImplementationOnce(async (payload) => {
      await finalizeRun(payload.agentRunId, { status: "COMPLETED", blocks: [{ type: "text", content: "already done" }] });
      throw new Error("the response was lost");
    });
    expect((await send("u1", chat, { content: "Raced" })).status).toBe(503);
    expect(await prisma.agentRun.count()).toBe(1); // not deleted: it had already ended on its own
    expect((await credits("u1")).held).toBe(0);
  });
});

describe("when small things go wrong after the agent has started", () => {
  it("still answers 201, with an already-expired token so the client asks for a new one, if no token can be made", async () => {
    const chat = await newChat("u1");
    trigger.tokenError = new Error("signing failed");
    const res = await send("u1", chat, { content: "No token" });
    expect(res.status).toBe(201);
    expect(sent(res).realtimeToken).toBe("");
    expect(new Date(sent(res).realtimeTokenExpiresAt).getTime()).toBeLessThan(Date.now());
    expect(await prisma.agentRun.count()).toBe(1);
  });

  it("retries saving the Trigger.dev run id, and never fails the send over it", async () => {
    const chat = await newChat("u1");
    const real = prisma.agentRun.updateMany.bind(prisma.agentRun);
    const spy = vi.spyOn(prisma.agentRun, "updateMany");
    spy.mockRejectedValueOnce(new Error("blip")).mockRejectedValueOnce(new Error("blip")).mockImplementation(real);

    const res = await send("u1", chat, { content: "Flaky save" });
    expect(res.status).toBe(201);
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: sent(res).runId } })).triggerRunId).toBe(sent(res).triggerRunId);
  });

  it("still answers 201 with the right run id if the save keeps failing (the task records its own id when it starts)", async () => {
    const chat = await newChat("u1");
    vi.spyOn(prisma.agentRun, "updateMany").mockRejectedValue(new Error("database unavailable"));
    const res = await send("u1", chat, { content: "Never saved" });
    expect(res.status).toBe(201);
    expect(sent(res).triggerRunId).toMatch(/^run_/);
    vi.restoreAllMocks();
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: sent(res).runId } })).triggerRunId).toBeNull();
  });
});

describe("failures of the database itself", () => {
  it("answers 503 and leaves nothing half-created when the database drops out during a send", async () => {
    const chat = await newChat("u1");
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("", { code: "ECONNREFUSED", clientVersion: "7.10.0" }));
    const res = await send("u1", chat, { content: "During an outage" });
    expect(res.status).toBe(503);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("SERVICE_UNAVAILABLE");
    vi.restoreAllMocks();
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.agentRun.count()).toBe(0);
    expect((await credits("u1")).held).toBe(0);
    expect(trigger.dispatches).toHaveLength(0);
    expect((await send("u1", chat, { content: "After the outage" })).status).toBe(201);
  });

  // A real fault, injected into the database: the last statement of the send's transaction fails.
  const injectFailure = () =>
    prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_chat_update() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_chat_update BEFORE UPDATE ON "Chat" FOR EACH ROW EXECUTE FUNCTION test_fail_chat_update();`);
  const removeFailure = () => prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_chat_update ON "Chat"`);

  it("rolls everything back when a step inside the transaction fails", async () => {
    const chat = await newChat("u1");
    await injectFailure();
    try {
      expect((await send("u1", chat, { content: "Almost" })).status).toBe(500);
    } finally {
      await removeFailure();
    }
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.agentRun.count()).toBe(0);
    expect(await prisma.creditLedger.count({ where: { type: "HOLD" } })).toBe(0); // the hold was written first, and is gone
    expect((await credits("u1")).held).toBe(0);
    expect(trigger.dispatches).toHaveLength(0);
  });

});

describe("a send racing other operations", () => {
  it("never leaves rows or credit holds behind when the chat is deleted at the same moment", async () => {
    for (let round = 0; round < 10; round++) {
      const chat = await newChat("u1");
      const [sendRes, deleteRes] = await Promise.all([send("u1", chat, { content: `race ${round}` }), as("u1").delete(`/api/chats/${chat}`)]);
      expect([201, 404, 409, 503]).toContain(sendRes.status);
      expect([204, 404]).toContain(deleteRes.status);
    }
    expect(await prisma.chat.count()).toBe(0);
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.agentRun.count()).toBe(0);
    expect((await credits("u1")).held).toBe(0);
    const ledger = await prisma.creditLedger.findMany({ where: { type: { in: ["HOLD", "RELEASE"] } } });
    expect(ledger.reduce((sum, row) => sum + row.amount, 0)).toBe(0);
  });

  it("gives every finished turn its credits back, whatever mix of ends they had", async () => {
    const chats = await Promise.all(Array.from({ length: 5 }, () => newChat("u1")));
    const runs = (await Promise.all(chats.map((chat) => send("u1", chat, { content: "go" })))).map((r) => sent(r).runId);
    await Promise.all([
      finalizeRun(runs[0] as string, { status: "COMPLETED", blocks: [{ type: "text", content: "ok" }] }),
      finalizeRun(runs[1] as string, { status: "FAILED", errorCode: "X" }),
      finalizeRun(runs[2] as string, { status: "CANCELLED" }),
      finalizeRun(runs[3] as string, { status: "CANCELLED" }),
      finalizeRun(runs[3] as string, { status: "FAILED", errorCode: "X" }), // loses the race for run 3
    ]);
    expect((await credits("u1")).held).toBe(HOLD); // only run 4 is still going
  });
});

describe("the send limiter in the full app", () => {
  it("allows a small number of sends per minute per user and answers 429 after that, without affecting other routes or users", async () => {
    const tight = createApp({ rateLimits: { authenticated: 1_000, anonymous: 1_000 }, sendLimit: 2 });
    const post = (user: string, chat: string) => api(tight).post(`/api/chats/${chat}/messages`).set("Authorization", `Bearer test:${user}`).send({ content: "hi" });
    const make = async (user: string) => createdId(await api(tight).post("/api/chats").set("Authorization", `Bearer test:${user}`).send({}));
    const [a, b, c, other] = [await make("u1"), await make("u1"), await make("u1"), await make("u2")];

    expect([(await post("u1", a)).status, (await post("u1", b)).status, (await post("u1", c)).status]).toEqual([201, 201, 429]);
    const blocked = await post("u1", c);
    expect(ErrorResponseSchema.parse(blocked.body).code).toBe("RATE_LIMITED");
    expect((await api(tight).get("/api/credits").set("Authorization", "Bearer test:u1")).status).toBe(200);
    expect((await post("u2", other)).status).toBe(201);
    expect(await prisma.agentRun.count({ where: { userId: "u1" } })).toBe(2); // the blocked send created nothing
  });
});

describe("attachments: files from the user's library", () => {
  const HOUR = 3_600_000;
  async function file(userId: string, data: { source?: "UPLOAD" | "GENERATED"; name?: string; expiresInHours?: number } = {}) {
    const upload = (data.source ?? "UPLOAD") === "UPLOAD";
    return prisma.mediaAsset.create({
      data: {
        userId,
        source: upload ? "UPLOAD" : "GENERATED",
        type: "IMAGE",
        url: `https://cdn.test/${crypto.randomUUID()}.png`,
        ...(upload ? { name: data.name ?? "photo.png", expiresAt: new Date(Date.now() + (data.expiresInHours ?? 20) * HOUR) } : { prompt: "a fox", model: "GPT Image 2" }),
      },
    });
  }
  const refs = (...ids: string[]) => ids.map((mediaAssetId) => ({ mediaAssetId }));
  const listMessages = async (user: string, chatId: string) => (await as(user).get(`/api/chats/${chatId}/messages`)).body as { messages: { role: string; attachments?: { id: string; expired: boolean; name: string | null; source: string }[] }[] };

  it("attaches files in the order given and returns them with the message", async () => {
    const chat = await newChat("u1");
    const [photo, generated] = [await file("u1", { name: "beach.png" }), await file("u1", { source: "GENERATED" })];
    const res = await send("u1", chat, { content: "Crop the first one", attachments: refs(photo.id, generated.id) });
    expect(res.status).toBe(201);
    const body = SendMessageResponseSchema.parse(res.body);
    expect(body.message.attachments?.map((a) => [a.id, a.source, a.name, a.expired])).toEqual([
      [photo.id, "upload", "beach.png", false],
      [generated.id, "generated", null, false],
    ]);
    expect(await prisma.attachment.findMany({ orderBy: { position: "asc" }, select: { mediaAssetId: true, position: true, messageId: true } })).toEqual([
      { mediaAssetId: photo.id, position: 0, messageId: body.message.id },
      { mediaAssetId: generated.id, position: 1, messageId: body.message.id },
    ]);
  });

  it("lists them on the user's message, in order, marking an upload expired once it's past its lifetime", async () => {
    const chat = await newChat("u1");
    const [a, b] = [await file("u1", { name: "a.png" }), await file("u1", { name: "b.png" })];
    expect((await send("u1", chat, { content: "two files", attachments: refs(b.id, a.id) })).status).toBe(201);
    const listed = (await listMessages("u1", chat)).messages.find((m) => m.role === "USER");
    expect(listed?.attachments?.map((x) => [x.name, x.expired])).toEqual([["b.png", false], ["a.png", false]]);
    await prisma.mediaAsset.update({ where: { id: b.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const later = (await listMessages("u1", chat)).messages.find((m) => m.role === "USER");
    expect(later?.attachments?.map((x) => [x.name, x.expired])).toEqual([["b.png", true], ["a.png", false]]);
  });

  it("leaves the attachments field off a message without files", async () => {
    const chat = await newChat("u1");
    const body = SendMessageResponseSchema.parse((await send("u1", chat, { content: "plain" })).body);
    expect(body.message.attachments).toBeUndefined();
  });

  it.each([
    ["another user's file", async () => [(await file("u2")).id], "attachments.0: That file isn't in your library."],
    ["a file that doesn't exist", () => Promise.resolve(["cmuqzzzzz0000zzzzzzzzzzzz"]), "attachments.0: That file isn't in your library."],
    ["an expired upload", async () => [(await file("u1", { expiresInHours: -1 })).id], "attachments.0: This file has expired. Upload it again."],
    ["a bad file after a good one", async () => [(await file("u1")).id, (await file("u2")).id], "attachments.1: That file isn't in your library."],
  ])("refuses %s, writing nothing", async (_label, ids, message) => {
    const chat = await newChat("u1");
    await prisma.user.upsert({ where: { id: "u2" }, update: {}, create: { id: "u2", balance: START } });
    const attach = await ids();
    const before = await counts();
    const res = await send("u1", chat, { content: "hi", attachments: refs(...attach) });
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body).error).toBe(message);
    await nothingHappened("u1", before);
    expect(await prisma.attachment.count()).toBe(0);
  });

  it.each([
    ["the same file twice", (id: string) => refs(id, id), /attached once/],
    ["11 files", (id: string) => Array.from({ length: 11 }, (_, i) => ({ mediaAssetId: `${id}${i}` })), /at most 10 files/],
  ])("refuses %s before anything is looked up", async (_label, build, message) => {
    const chat = await newChat("u1");
    const photo = await file("u1");
    const before = await counts();
    const res = await send("u1", chat, { content: "hi", attachments: build(photo.id) });
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body).error).toMatch(message);
    await nothingHappened("u1", before);
  });

  it("treats a resent message with the same files as the same turn, and different files as a different message", async () => {
    const chat = await newChat("u1");
    const [a, b] = [await file("u1"), await file("u1")];
    const clientMessageId = uuid();
    const first = SendMessageResponseSchema.parse((await send("u1", chat, { content: "hi", clientMessageId, attachments: refs(a.id) })).body);
    const again = await send("u1", chat, { content: "hi", clientMessageId, attachments: refs(a.id) });
    expect(SendMessageResponseSchema.parse(again.body).runId).toBe(first.runId);
    const changed = await send("u1", chat, { content: "hi", clientMessageId, attachments: refs(b.id) });
    expect(changed.status).toBe(400);
    expect(ErrorResponseSchema.parse(changed.body).error).toMatch(/already used for a different message/);
    const reordered = await send("u1", chat, { content: "hi", clientMessageId, attachments: refs(a.id, b.id) });
    expect(reordered.status).toBe(400);
    expect(await prisma.attachment.count()).toBe(1);
  });

  it("keeps the files when the turn is retried (the same question, no new attachment rows)", async () => {
    const chat = await newChat("u1");
    const photo = await file("u1", { name: "keep.png" });
    const first = SendMessageResponseSchema.parse((await send("u1", chat, { content: "crop it", attachments: refs(photo.id) })).body);
    await finalizeRun(first.runId, { status: "FAILED", errorCode: "MODEL_UNAVAILABLE", errorMessage: "down" });
    const retried = await as("u1").post(`/api/runs/${first.runId}/retry`);
    expect(retried.status).toBe(201);
    expect((retried.body as { message: { attachments?: { name: string }[] } }).message.attachments?.map((a) => a.name)).toEqual(["keep.png"]);
    expect(await prisma.attachment.count()).toBe(1);
  });

  it("keeps a generated file attachable for ever (it doesn't expire)", async () => {
    const chat = await newChat("u1");
    const generated = await file("u1", { source: "GENERATED" });
    expect((await send("u1", chat, { content: "use this", attachments: refs(generated.id) })).status).toBe(201);
  });
});
