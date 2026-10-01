import { PrismaPg } from "@prisma/adapter-pg";
import { beforeEach, describe, expect, it } from "vitest";
import { ErrorResponseSchema, MessageListResponseSchema } from "#src/contracts/index.js";
import { prisma, type Prisma } from "#src/db/client.js";
import { env } from "#src/env/base.js";
import { PrismaClient } from "#src/generated/prisma/client.js";
import { encodeCursor } from "#src/lib/cursor.js";
import { listMessages } from "#src/services/messages.js";
import { finalizeRun } from "#src/services/runs.js";
import { anonymous, as } from "../helpers/app.js";
import { activeTurn, fixtures, resetDb } from "../helpers/db.js";

beforeEach(resetDb);

const T0 = new Date("2026-06-01T00:00:00.000Z").getTime();
const at = (seconds: number) => new Date(T0 + seconds * 1000);

interface Row {
  id: string;
  role: string;
  content: string | null;
  status: string;
  agentRunId: string | null;
  clientMessageId: string | null;
  contentBlocks: unknown[];
  createdAt: string;
}
interface ListBody {
  messages: Row[];
  cursor: string | null;
}
type Res = { body: unknown; status: number };
const list = (res: Res) => res.body as ListBody;
const ids = (res: Res) => list(res).messages.map((m) => m.id);
const page = (chatId: string, query: Record<string, string | number> = {}, user = "u1") => as(user).get(`/api/chats/${chatId}/messages`).query(query);

async function setup() {
  const user = await fixtures.user({ id: "u1", balance: 30_000_000 });
  return { user, chat: await fixtures.chat(user.id) };
}

/** Finished messages with exact ids and timestamps, oldest first (`m000` is the oldest). */
async function seed(chatId: string, count: number, options: { sameTime?: boolean } = {}) {
  const data = Array.from({ length: count }, (_, i) => ({
    id: `m${String(i).padStart(3, "0")}`,
    chatId,
    userId: "u1",
    role: i % 2 === 0 ? ("USER" as const) : ("ASSISTANT" as const),
    content: `message ${i}`,
    createdAt: at(options.sameTime ? 100 : i),
  }));
  await prisma.message.createMany({ data });
  return data.map((m) => m.id);
}

async function walk(chatId: string, limit: number): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | null = null;
  do {
    const res = await page(chatId, { limit, ...(cursor && { cursor }) });
    expect(res.status).toBe(200);
    const body = MessageListResponseSchema.parse(res.body);
    pages.push(body.messages.map((m) => m.id));
    cursor = body.cursor;
    expect(pages.length).toBeLessThan(500);
  } while (cursor);
  return pages;
}

describe("GET /api/chats/:chatId/messages: what is listed", () => {
  it("is empty, with no cursor, for a chat with no messages", async () => {
    const { chat } = await setup();
    const res = await page(chat.id);
    expect(res.status).toBe(200);
    expect(MessageListResponseSchema.parse(res.body)).toEqual({ messages: [], cursor: null });
  });

  it("lists finished messages, oldest first within the page, in the contract shape", async () => {
    const { chat } = await setup();
    await seed(chat.id, 4);
    const res = await page(chat.id);
    expect(MessageListResponseSchema.safeParse(res.body).success).toBe(true);
    expect(ids(res)).toEqual(["m000", "m001", "m002", "m003"]);
    expect(list(res).messages[0]).toMatchObject({ role: "USER", content: "message 0", status: "COMPLETED", agentRunId: null, clientMessageId: null });
    expect(list(res).messages[0]?.createdAt).toBe(at(0).toISOString());
  });

  it("hides a reply that is still being written, but shows the question that started it", async () => {
    const { chat } = await setup();
    const { userMessage, assistantMessage } = await activeTurn(chat.id, "u1");
    const res = await page(chat.id);
    expect(ids(res)).toEqual([userMessage.id]);
    expect(ids(res)).not.toContain(assistantMessage.id);
  });

  it("shows the reply once it is finished, including failed and cancelled ones (a failed turn stays visible)", async () => {
    const { chat } = await setup();
    const turns = [
      { outcome: { status: "COMPLETED" as const, blocks: [{ type: "text" as const, content: "Done" }] }, status: "COMPLETED" },
      { outcome: { status: "FAILED" as const, errorCode: "AGENT_FAILED" }, status: "FAILED" },
      { outcome: { status: "CANCELLED" as const }, status: "CANCELLED" },
    ];
    for (const { outcome } of turns) {
      const { run } = await activeTurn(chat.id, "u1");
      await finalizeRun(run.id, outcome);
    }
    const replies = list(await page(chat.id)).messages.filter((m) => m.role === "ASSISTANT");
    expect(replies.map((m) => m.status)).toEqual(["COMPLETED", "FAILED", "CANCELLED"]);
    expect(replies[0]).toMatchObject({ content: "Done", contentBlocks: [{ type: "text", content: "Done" }] });
  });

  it("puts each question before its answer, so the conversation reads in order", async () => {
    const { chat } = await setup();
    for (let i = 0; i < 4; i++) {
      const { run } = await activeTurn(chat.id, "u1", { ageMs: (8 - i * 2) * 1_000 });
      await finalizeRun(run.id, { status: "COMPLETED", blocks: [{ type: "text", content: `a${i}` }] });
    }
    expect(list(await page(chat.id)).messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT", "USER", "ASSISTANT", "USER", "ASSISTANT", "USER", "ASSISTANT"]);
  });

  it("labels both the question and its answer with the run they belong to", async () => {
    const { chat } = await setup();
    const { run } = await activeTurn(chat.id, "u1");
    await finalizeRun(run.id, { status: "COMPLETED", blocks: [{ type: "text", content: "ok" }] });
    const { messages } = list(await page(chat.id));
    expect(messages.map((m) => m.agentRunId)).toEqual([run.id, run.id]);
  });

  it("points a question at its latest run when it has been run more than once", async () => {
    const { chat } = await setup();
    const first = await activeTurn(chat.id, "u1");
    await finalizeRun(first.run.id, { status: "FAILED", errorCode: "AGENT_FAILED" });
    const secondReply = await prisma.message.create({ data: { chatId: chat.id, userId: "u1", role: "ASSISTANT", status: "COMPLETED", content: "retry", createdAt: new Date() } });
    const second = await prisma.agentRun.create({
      data: { chatId: chat.id, userId: "u1", triggerMessageId: first.userMessage.id, assistantMessageId: secondReply.id, status: "COMPLETED", traceId: "t", createdAt: new Date(Date.now() + 1000) },
    });
    const question = list(await page(chat.id)).messages.find((m) => m.id === first.userMessage.id);
    expect(question?.agentRunId).toBe(second.id);
  });

  it("returns the client's message id on the question, and none on the answer", async () => {
    const { chat } = await setup();
    const id = crypto.randomUUID();
    const res = await as("u1").post(`/api/chats/${chat.id}/messages`).send({ content: "with an id", clientMessageId: id });
    const body = res.body as { runId: string };
    await finalizeRun(body.runId, { status: "COMPLETED", blocks: [{ type: "text", content: "ok" }] });
    const { messages } = list(await page(chat.id));
    expect(messages.map((m) => m.clientMessageId)).toEqual([id, null]);
  });

  it("never mixes in another chat's messages", async () => {
    const { chat } = await setup();
    const other = await fixtures.chat("u1");
    await seed(chat.id, 3);
    await prisma.message.create({ data: { id: "elsewhere", chatId: other.id, userId: "u1", role: "USER", content: "other chat", createdAt: at(1) } });
    expect(ids(await page(chat.id))).not.toContain("elsewhere");
  });

  it("does not crash on stored content that is damaged, and shows what is readable", async () => {
    const { chat } = await setup();
    await seed(chat.id, 1);
    for (const damaged of [{ not: "an array" }, "a string", 7, [null, { type: "from-the-future" }, { type: "text", content: "readable" }]] as Prisma.InputJsonValue[]) {
      await prisma.message.update({ where: { id: "m000" }, data: { contentBlocks: damaged } });
      const res = await page(chat.id);
      expect(res.status).toBe(200);
      expect(Array.isArray(list(res).messages[0]?.contentBlocks)).toBe(true);
    }
    expect(list(await page(chat.id)).messages[0]?.contentBlocks).toEqual([{ type: "text", content: "readable" }]);
  });
});

describe("GET /api/chats/:chatId/messages: access", () => {
  it("needs a signed-in user", async () => {
    const { chat } = await setup();
    expect((await anonymous().get(`/api/chats/${chat.id}/messages`)).status).toBe(401);
  });

  it("is 404 for another user's chat, a missing chat and an impossible id, and reveals nothing", async () => {
    const { chat } = await setup();
    await seed(chat.id, 2);
    await as("intruder").get("/api/credits");
    for (const id of [chat.id, "doesnotexist", "%00", "x".repeat(65)]) {
      const res = await as("intruder").get(`/api/chats/${id}/messages`);
      expect(res.status, id).toBe(404);
      expect(ErrorResponseSchema.parse(res.body).code).toBe("NOT_FOUND");
      expect(JSON.stringify(res.body)).not.toContain("message 0");
    }
  });
});

describe("GET /api/chats/:chatId/messages: paging", () => {
  it("defaults to 50 messages and never exceeds 100, newest page first", async () => {
    const { chat } = await setup();
    await seed(chat.id, 120);
    const first = await page(chat.id);
    expect(list(first).messages).toHaveLength(50);
    expect(ids(first)[49]).toBe("m119"); // the newest message is last on the newest page
    expect(ids(first)[0]).toBe("m070");
    expect(list(await page(chat.id, { limit: 100 })).messages).toHaveLength(100);
    expect(list(await page(chat.id, { limit: 1 })).messages).toHaveLength(1);
  });

  it.each(["0", "101", "-1", "abc", "", "1.5"])("rejects limit=%j with 400", async (limit) => {
    const { chat } = await setup();
    const res = await as("u1").get(`/api/chats/${chat.id}/messages`).query({ limit });
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("VALIDATION_FAILED");
  });

  it("walks back through 120 messages with no gap and no repeat, ending with a null cursor", async () => {
    const { chat } = await setup();
    const all = await seed(chat.id, 120);
    const pages = await walk(chat.id, 50);
    expect(pages.map((p) => p.length)).toEqual([50, 50, 20]);
    expect(pages.flat().sort()).toEqual([...all].sort());
    expect(new Set(pages.flat()).size).toBe(120);
    expect(pages[0]?.at(-1)).toBe("m119"); // newest page first
    expect(pages[2]?.[0]).toBe("m000");
  });

  it("gives no cursor when the last page is exactly full, and one when a single message remains", async () => {
    const { chat } = await setup();
    await seed(chat.id, 10);
    expect(list(await page(chat.id, { limit: 10 })).cursor).toBeNull();
    await prisma.message.create({ data: { id: "m999", chatId: chat.id, userId: "u1", role: "USER", content: "one more", createdAt: at(999) } });
    expect(list(await page(chat.id, { limit: 10 })).cursor).toEqual(expect.any(String));
  });

  it("orders messages with exactly the same timestamp by id, and walks them one at a time without losing any", async () => {
    const { chat } = await setup();
    const all = await seed(chat.id, 25, { sameTime: true });
    const pages = await walk(chat.id, 1);
    expect(pages).toHaveLength(25);
    expect(pages.flat()).toEqual([...all].reverse()); // newest page first; ties broken by id, descending
  });

  it("matches the expected order for random data at many page sizes", async () => {
    const { chat } = await setup();
    let state = 99;
    const random = () => (state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296) / 4_294_967_296;
    const data = Array.from({ length: 70 }, (_, i) => ({
      id: `r${String(i).padStart(3, "0")}`,
      chatId: chat.id,
      userId: "u1",
      role: "USER" as const,
      content: `r${i}`,
      createdAt: at(Math.floor(random() * 8)), // only eight distinct times, so there are many ties
    }));
    await prisma.message.createMany({ data });
    const expected = [...data].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1)).map((m) => m.id);
    for (const limit of [1, 3, 7, 13, 50, 69, 70, 100]) {
      const pages = await walk(chat.id, limit);
      // pages come newest first, but each page reads oldest first
      expect(pages.flatMap((p) => [...p].reverse()), `limit ${limit}`).toEqual(expected);
    }
  });

  it("pages stay correct while new messages arrive, and older pages are unaffected", async () => {
    const { chat } = await setup();
    await seed(chat.id, 30);
    const first = list(await page(chat.id, { limit: 10 }));
    const { run } = await activeTurn(chat.id, "u1", { ageMs: 0 });
    await finalizeRun(run.id, { status: "COMPLETED", blocks: [{ type: "text", content: "new" }] });
    const second = list(await page(chat.id, { limit: 10, cursor: first.cursor as string }));
    expect(second.messages.map((m) => m.id)).toEqual(["m010", "m011", "m012", "m013", "m014", "m015", "m016", "m017", "m018", "m019"]);
  });
});

describe("GET /api/chats/:chatId/messages: cursors", () => {
  const payload = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const time = "2026-06-01T00:10:00.000Z";

  it.each([
    ["garbage", "!!!***"],
    ["base64 of text", payload("hello")],
    ["an empty tuple", payload([])],
    ["wrong arity", payload([time])],
    ["a chat-list style cursor", payload([0, time, "x"])],
    ["not a date", payload(["yesterday", "x"])],
    ["year 0000 (the database would reject it)", payload(["0000-01-01T00:00:00.000Z", "x"])],
    ["year 9999", payload(["9999-12-31T23:59:59.999Z", "x"])],
    ["id too long", payload([time, "x".repeat(65)])],
    ["NUL in the id", payload([time, "a\u0000b"])],
    ["id as a number", payload([time, 7])],
    ["oversized", "a".repeat(513)],
  ])("rejects a bad cursor with 400 and no data: %s", async (_label, cursor) => {
    const { chat } = await setup();
    await seed(chat.id, 2);
    const res = await as("u1").get(`/api/chats/${chat.id}/messages`).query({ cursor });
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("VALIDATION_FAILED");
    expect((res.body as Partial<ListBody>).messages).toBeUndefined();
  });

  it("returns an empty page for a cursor older than everything, and everything for one far in the future", async () => {
    const { chat } = await setup();
    await seed(chat.id, 3);
    expect(list(await page(chat.id, { cursor: encodeCursor(["2000-01-01T00:00:00.000Z", "a"]) }))).toEqual({ messages: [], cursor: null });
    expect(ids(await page(chat.id, { cursor: encodeCursor(["2150-01-01T00:00:00.000Z", "zzz"]) }))).toEqual(["m000", "m001", "m002"]);
  });

  it("uses a cursor from another chat only as a position, never returning that chat's messages", async () => {
    const { chat } = await setup();
    const other = await fixtures.chat("u1");
    await seed(chat.id, 6);
    await prisma.message.createMany({
      data: Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, chatId: other.id, userId: "u1", role: "USER" as const, content: `other ${i}`, createdAt: at(i) })),
    });
    const theirs = list(await page(other.id, { limit: 3 })).cursor as string;
    const res = await page(chat.id, { cursor: theirs });
    expect(res.status).toBe(200);
    for (const id of ids(res)) expect(id.startsWith("m")).toBe(true);
  });
});

describe("the message list query itself (the SQL Prisma really sends)", () => {
  async function recorded(run: (db: PrismaClient) => Promise<unknown>) {
    const statements: { query: string; params: string }[] = [];
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }), log: [{ emit: "event", level: "query" }] });
    db.$on("query", (event) => statements.push({ query: event.query, params: event.params }));
    try {
      await run(db);
    } finally {
      await db.$disconnect();
    }
    return statements.filter((s) => /FROM "public"\."Message"/.test(s.query) && /ORDER BY/.test(s.query));
  }

  const cursor = encodeCursor(["2026-06-01T00:05:00.000Z", "m050"]);

  it.each([
    ["first page", undefined],
    ["an older page", cursor],
  ])("is scoped to the chat, hides unfinished replies, and orders by time then id descending (%s)", async (_label, cur) => {
    const { chat } = await setup();
    await seed(chat.id, 3);
    const [statement] = await recorded((db) => listMessages("u1", chat.id, { limit: 50, ...(cur && { cursor: cur }) }, db));
    expect(statement?.query).toMatch(/"chatId" = \$1/);
    expect(statement?.query).toMatch(/"status" <> CAST\(\$2::text AS "public"\."MessageStatus"\)|"status" <> \$2/);
    expect(statement?.query).toMatch(/ORDER BY [^\n]*"createdAt" DESC[^\n]*"id" DESC/);
    expect(statement?.query).toMatch(/LIMIT/);
  });

  it.each([
    ["first page", undefined],
    ["an older page", cursor],
  ])("is served from the composite index in order, with no sort and no table scan (%s)", async (_label, cur) => {
    const { chat } = await setup();
    await seed(chat.id, 3);
    const [statement] = await recorded((db) => listMessages("u1", chat.id, { limit: 50, ...(cur && { cursor: cur }) }, db));
    expect(statement).toBeDefined();
    const params = JSON.parse(statement?.params ?? "[]") as unknown[];
    const plan = await prisma.$transaction(async (tx) => {
      for (const knob of ["enable_seqscan", "enable_bitmapscan", "enable_sort"]) await tx.$executeRawUnsafe(`SET LOCAL ${knob} = off`);
      const rows = await tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${statement?.query ?? ""}`, ...params);
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("Message_chatId_createdAt_id_idx");
    expect(plan).not.toMatch(/\bSort\b/);
    expect(plan).not.toContain("Seq Scan");
  });

  it("finds each page's runs with a fixed number of indexed lookups, not one query per message", async () => {
    const { chat } = await setup();
    await seed(chat.id, 40);
    const queries: string[] = [];
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }), log: [{ emit: "event", level: "query" }] });
    db.$on("query", (event) => queries.push(event.query));
    try {
      await listMessages("u1", chat.id, { limit: 40 }, db);
    } finally {
      await db.$disconnect();
    }
    const runQueries = queries.filter((q) => /FROM "public"\."AgentRun"/.test(q));
    // the page's runs, plus the chat's latest run (which decides the one reply that can be retried)
    expect(runQueries).toHaveLength(2);
    expect(runQueries.filter((q) => /LIMIT/.test(q) && /"chatId" = \$1/.test(q))).toHaveLength(1);
    expect(queries.filter((q) => /FROM "public"\."Message"/.test(q))).toHaveLength(1);
  });
});
