import { beforeEach, describe, expect, it } from "vitest";
import { ChatListResponseSchema, ChatResponseSchema, ErrorResponseSchema } from "#src/contracts/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { prisma } from "#src/db/client.js";
import { env } from "#src/env/base.js";
import { PrismaClient } from "#src/generated/prisma/client.js";
import { listChats } from "#src/services/chats.js";
import { encodeCursor } from "#src/lib/cursor.js";
import { anonymous, as } from "../helpers/app.js";
import { fixtures, resetDb } from "../helpers/db.js";

beforeEach(resetDb);

const T0 = new Date("2026-06-01T00:00:00.000Z").getTime();
const at = (seconds: number) => new Date(T0 + seconds * 1000);

interface Seed {
  id: string;
  seconds: number; // lastMessageAt, as an offset so ties are easy to make
  pinned?: boolean;
}

/** Inserts chats with exact ids and timestamps, so ordering, ties and paging are fully deterministic. */
async function seed(userId: string, chats: Seed[]) {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, balance: 1_000_000 } });
  await prisma.chat.createMany({
    data: chats.map((c) => ({ id: c.id, userId, isPinned: c.pinned ?? false, lastMessageAt: at(c.seconds), createdAt: at(c.seconds) })),
  });
}

/** The order the API promises: pinned first, then newest activity, then id (descending) to break ties. */
const canonical = (chats: Seed[]) =>
  [...chats]
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.seconds - a.seconds || (a.id < b.id ? 1 : -1))
    .map((c) => c.id);

interface ListBody {
  chats: { id: string; userId: string }[];
  cursor: string | null;
}
type Res = { body: unknown };
const listBody = (res: Res) => res.body as ListBody;
const idsOf = (res: Res) => listBody(res).chats.map((c) => c.id);
const createdId = (res: Res) => (res.body as { chat: { id: string } }).chat.id;
const chatOf = (res: Res) => (res.body as { chat: { id: string; title: string; isPinned: boolean; lastMessageAt: string; updatedAt: string } }).chat;

const listPage = (user: string, query: Record<string, string | number> = {}) => as(user).get("/api/chats").query(query);

/** Follows the cursor to the end; returns the ids of each page. */
async function walk(user: string, limit: number): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | null = null;
  do {
    const res = await listPage(user, { limit, ...(cursor && { cursor }) });
    expect(res.status).toBe(200);
    const body = ChatListResponseSchema.parse(res.body);
    pages.push(body.chats.map((c) => c.id));
    cursor = body.cursor;
    expect(pages.length).toBeLessThan(500); // a runaway cursor would otherwise loop forever
  } while (cursor);
  return pages;
}

// a small deterministic generator, so a failure can be reproduced exactly
function prng(seedValue: number) {
  let state = seedValue;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

describe("authentication", () => {
  it.each([
    ["GET /api/chats", (r: ReturnType<typeof anonymous>) => r.get("/api/chats")],
    ["POST /api/chats", (r: ReturnType<typeof anonymous>) => r.post("/api/chats").send({})],
    ["GET /api/chats/x", (r: ReturnType<typeof anonymous>) => r.get("/api/chats/x")],
    ["PATCH /api/chats/x", (r: ReturnType<typeof anonymous>) => r.patch("/api/chats/x").send({ title: "a" })],
    ["DELETE /api/chats/x", (r: ReturnType<typeof anonymous>) => r.delete("/api/chats/x")],
  ])("%s needs a signed-in user", async (_label, send) => {
    const res = await send(anonymous());
    expect(res.status).toBe(401);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("UNAUTHORIZED");
  });
});

describe("POST /api/chats", () => {
  it("creates a chat with the default title, owned by the caller, and returns 201 in the contract shape", async () => {
    const res = await as("u1").post("/api/chats").send({});
    expect(res.status).toBe(201);
    const { chat } = ChatResponseSchema.parse(res.body);
    expect(chat).toMatchObject({ title: "New chat", userId: "u1", isPinned: false });
    expect(chat.lastMessageAt).toBe(chat.createdAt); // never null: a new chat sorts by when it was made
    expect(await prisma.chat.count({ where: { userId: "u1" } })).toBe(1);
  });

  it("accepts a request with no body at all, and one with no Content-Type", async () => {
    expect((await as("u1").post("/api/chats")).status).toBe(201);
    expect((await as("u1").post("/api/chats").type("text/plain").send("ignored")).status).toBe(201);
  });

  it("uses and trims a given title", async () => {
    const res = await as("u1").post("/api/chats").send({ title: "  Holiday plans  " });
    expect(chatOf(res).title).toBe("Holiday plans");
  });

  it("stores unusual titles exactly (emoji, scripts, markup is data, not code)", async () => {
    for (const title of ["日本語 \u{1F642}", "<script>alert(1)</script>", "'; DROP TABLE \"Chat\";--", "a".repeat(200)]) {
      const res = await as("u1").post("/api/chats").send({ title });
      expect(res.status).toBe(201);
      expect(chatOf(res).title).toBe(title);
    }
    expect(await prisma.chat.count()).toBe(4);
  });

  it.each([
    ["empty title", { title: "" }],
    ["whitespace title", { title: "   " }],
    ["invisible title", { title: "​​" }],
    ["title too long", { title: "x".repeat(201) }],
    ["NUL in title", { title: "a\u0000b" }],
    ["title of the wrong type", { title: 5 }],
    ["unknown field", { title: "ok", extra: 1 }],
    ["trying to set the owner", { userId: "someone-else" }],
    ["trying to set pinned", { isPinned: true }],
    ["trying to set an id", { id: "chosen" }],
  ])("rejects %s with 400 and creates nothing", async (_label, body) => {
    const res = await as("u1").post("/api/chats").send(body);
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("VALIDATION_FAILED");
    expect(await prisma.chat.count()).toBe(0);
  });

  it("puts the new chat at the top of the list", async () => {
    await seed("u1", [{ id: "old", seconds: -5000 }]);
    const created = createdId(await as("u1").post("/api/chats").send({ title: "Newest" }));
    const list = idsOf(await listPage("u1"));
    expect(list).toEqual([created, "old"]);
  });

  it("creates every chat when many requests arrive at once", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => as("u1").post("/api/chats").send({})));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map(createdId)).size).toBe(20);
    expect(await prisma.chat.count()).toBe(20);
  });
});

describe("GET /api/chats/:chatId", () => {
  it("returns the caller's chat", async () => {
    const id = createdId(await as("u1").post("/api/chats").send({ title: "Mine" }));
    const res = await as("u1").get(`/api/chats/${id}`);
    expect(res.status).toBe(200);
    expect(ChatResponseSchema.parse(res.body).chat).toMatchObject({ id, title: "Mine", userId: "u1" });
  });

  it("answers another user's chat exactly like a chat that does not exist (nothing to learn from the difference)", async () => {
    const theirs = createdId(await as("owner").post("/api/chats").send({ title: "Private" }));
    const foreign = await as("intruder").get(`/api/chats/${theirs}`);
    const missing = await as("intruder").get("/api/chats/doesnotexist");
    expect(foreign.status).toBe(404);
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
    expect(ErrorResponseSchema.parse(foreign.body)).toMatchObject({ code: "NOT_FOUND" });
    expect(JSON.stringify(foreign.body)).not.toContain("Private");
  });

  it.each([
    ["too long", "x".repeat(65)],
    ["path traversal", "..%2F..%2Fetc%2Fpasswd"],
    ["NUL character", "%00"],
    ["unicode", "%E2%80%AE"],
    ["spaces", "a%20b"],
    ["SQL", "%27%20OR%201%3D1--"],
    ["percent-encoded slash", "a%2Fb"],
    ["very long", "a".repeat(5000)],
  ])("treats an impossible id as not found, not as an error: %s", async (_label, id) => {
    const res = await as("u1").get(`/api/chats/${id}`);
    expect(res.status).toBe(404);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("NOT_FOUND");
  });
});

describe("PATCH /api/chats/:chatId", () => {
  async function chat(title = "Original") {
    return chatOf(await as("u1").post("/api/chats").send({ title }));
  }

  it("renames, pins, or both", async () => {
    const { id } = await chat();
    expect(chatOf(await as("u1").patch(`/api/chats/${id}`).send({ title: "Renamed" }))).toMatchObject({ title: "Renamed", isPinned: false });
    expect(chatOf(await as("u1").patch(`/api/chats/${id}`).send({ isPinned: true }))).toMatchObject({ title: "Renamed", isPinned: true });
    expect(chatOf(await as("u1").patch(`/api/chats/${id}`).send({ title: "Both", isPinned: false }))).toMatchObject({ title: "Both", isPinned: false });
  });

  it("returns the contract shape, trims the title, and accepts setting the same value again", async () => {
    const { id } = await chat();
    const res = await as("u1").patch(`/api/chats/${id}`).send({ title: "  Padded  " });
    expect(ChatResponseSchema.parse(res.body).chat.title).toBe("Padded");
    expect((await as("u1").patch(`/api/chats/${id}`).send({ title: "Padded" })).status).toBe(200);
  });

  it("does not count as activity: lastMessageAt stays, updatedAt moves", async () => {
    const before = await chat();
    await new Promise((resolve) => setTimeout(resolve, 15));
    const after = chatOf(await as("u1").patch(`/api/chats/${before.id}`).send({ isPinned: true }));
    expect(after.lastMessageAt).toBe(before.lastMessageAt);
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(new Date(before.updatedAt).getTime());
  });

  it("moves a pinned chat to the top of the list and back again when unpinned", async () => {
    await seed("u1", [{ id: "a", seconds: 300 }, { id: "b", seconds: 200 }, { id: "c", seconds: 100 }]);
    const ids = async () => idsOf(await listPage("u1"));
    expect(await ids()).toEqual(["a", "b", "c"]);
    await as("u1").patch("/api/chats/c").send({ isPinned: true });
    expect(await ids()).toEqual(["c", "a", "b"]);
    await as("u1").patch("/api/chats/c").send({ isPinned: false });
    expect(await ids()).toEqual(["a", "b", "c"]);
  });

  it.each([
    ["an empty body", {}],
    ["an unknown field", { color: "red" }],
    ["trying to change the owner", { userId: "someone-else" }],
    ["trying to change the id", { id: "other" }],
    ["trying to change timestamps", { lastMessageAt: "2030-01-01T00:00:00.000Z" }],
    ["pinned of the wrong type", { isPinned: "yes" }],
    ["an empty title", { title: "" }],
    ["an invisible title", { title: "‮" }],
    ["NUL in the title", { title: "\u0000" }],
  ])("rejects %s with 400 and changes nothing", async (_label, body) => {
    const { id } = await chat();
    const res = await as("u1").patch(`/api/chats/${id}`).send(body);
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("VALIDATION_FAILED");
    expect(await prisma.chat.findUniqueOrThrow({ where: { id } })).toMatchObject({ title: "Original", userId: "u1", isPinned: false });
  });

  it("rejects a request with no body", async () => {
    const { id } = await chat();
    expect((await as("u1").patch(`/api/chats/${id}`)).status).toBe(400);
  });

  it("cannot touch another user's chat, and leaves it exactly as it was", async () => {
    const theirs = createdId(await as("owner").post("/api/chats").send({ title: "Theirs" }));
    const res = await as("intruder").patch(`/api/chats/${theirs}`).send({ title: "Hacked", isPinned: true });
    expect(res.status).toBe(404);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("NOT_FOUND");
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: theirs } })).toMatchObject({ title: "Theirs", isPinned: false, userId: "owner" });
  });

  it("is 404 for a chat that does not exist or has an impossible id", async () => {
    expect((await as("u1").patch("/api/chats/nope").send({ title: "x" })).status).toBe(404);
    expect((await as("u1").patch("/api/chats/%00").send({ title: "x" })).status).toBe(404);
  });

  it("survives concurrent edits (last write wins, nothing breaks)", async () => {
    const { id } = await chat();
    const results = await Promise.all(["a", "b", "c", "d", "e"].map((title) => as("u1").patch(`/api/chats/${id}`).send({ title })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(["a", "b", "c", "d", "e"]).toContain((await prisma.chat.findUniqueOrThrow({ where: { id } })).title);
  });
});

describe("DELETE /api/chats/:chatId", () => {
  it("deletes the chat (204, no body) and its messages", async () => {
    const user = await fixtures.user({ id: "u1" });
    const chat = await fixtures.chat(user.id);
    await fixtures.message(chat.id, user.id);
    const res = await as("u1").delete(`/api/chats/${chat.id}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect((await as("u1").get(`/api/chats/${chat.id}`)).status).toBe(404);
    expect(await prisma.message.count()).toBe(0);
  });

  it("is 404 the second time, so a repeated or raced delete is harmless", async () => {
    const id = createdId(await as("u1").post("/api/chats").send({}));
    expect((await as("u1").delete(`/api/chats/${id}`)).status).toBe(204);
    expect((await as("u1").delete(`/api/chats/${id}`)).status).toBe(404);
  });

  it("lets exactly one of several simultaneous deletes succeed", async () => {
    const id = createdId(await as("u1").post("/api/chats").send({}));
    const results = await Promise.all(Array.from({ length: 6 }, () => as("u1").delete(`/api/chats/${id}`)));
    expect(results.filter((r) => r.status === 204)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(5);
  });

  it("cannot delete another user's chat, and the chat survives", async () => {
    const theirs = createdId(await as("owner").post("/api/chats").send({ title: "Theirs" }));
    const res = await as("intruder").delete(`/api/chats/${theirs}`);
    expect(res.status).toBe(404);
    expect(await prisma.chat.count({ where: { id: theirs } })).toBe(1);
  });

  it("only removes the one chat", async () => {
    await seed("u1", [{ id: "keep1", seconds: 1 }, { id: "gone", seconds: 2 }, { id: "keep2", seconds: 3 }]);
    await as("u1").delete("/api/chats/gone");
    expect((await prisma.chat.findMany({ orderBy: { id: "asc" } })).map((c) => c.id)).toEqual(["keep1", "keep2"]);
  });

  it("is 404 for an impossible id", async () => {
    expect((await as("u1").delete("/api/chats/%00")).status).toBe(404);
  });
});

describe("GET /api/chats: what is listed", () => {
  it("is empty, with no cursor, for a user with no chats", async () => {
    const res = await listPage("u1");
    expect(res.status).toBe(200);
    expect(ChatListResponseSchema.parse(res.body)).toEqual({ chats: [], cursor: null });
  });

  it("lists only the caller's chats, never anyone else's", async () => {
    await seed("u1", [{ id: "mine1", seconds: 1 }, { id: "mine2", seconds: 2 }]);
    await seed("u2", [{ id: "theirs1", seconds: 3 }, { id: "theirs2", seconds: 4 }]);
    const ids = idsOf(await listPage("u1"));
    expect(ids.sort()).toEqual(["mine1", "mine2"]);
  });

  it("puts pinned chats first, then newest activity, then breaks exact ties by id", async () => {
    const chats: Seed[] = [
      { id: "p-old", seconds: 10, pinned: true },
      { id: "p-new", seconds: 900, pinned: true },
      { id: "u-new", seconds: 800 },
      { id: "tie-a", seconds: 500 },
      { id: "tie-c", seconds: 500 },
      { id: "tie-b", seconds: 500 },
      { id: "u-old", seconds: 1 },
    ];
    await seed("u1", chats);
    const ids = idsOf(await listPage("u1"));
    expect(ids).toEqual(canonical(chats));
    expect(ids).toEqual(["p-new", "p-old", "u-new", "tie-c", "tie-b", "tie-a", "u-old"]);
  });

  it("ignores query parameters it does not know (search is not built yet)", async () => {
    await seed("u1", [{ id: "a", seconds: 1 }]);
    expect(listBody(await listPage("u1", { q: "anything", sort: "title" })).chats).toHaveLength(1);
  });
});

describe("GET /api/chats: paging", () => {
  it("defaults to 50 per page and caps at 100", async () => {
    await seed("u1", Array.from({ length: 120 }, (_, i) => ({ id: `c${String(i).padStart(3, "0")}`, seconds: i })));
    expect(listBody(await listPage("u1")).chats).toHaveLength(50);
    expect(listBody(await listPage("u1", { limit: 100 })).chats).toHaveLength(100);
    expect(listBody(await listPage("u1", { limit: 1 })).chats).toHaveLength(1);
  });

  it.each(["0", "101", "-1", "abc", "", "1.5", "NaN"])("rejects limit=%j with 400", async (limit) => {
    const res = await as("u1").get("/api/chats").query({ limit });
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("VALIDATION_FAILED");
  });

  it("rejects a repeated limit parameter", async () => {
    expect((await as("u1").get("/api/chats?limit=5&limit=6")).status).toBe(400);
  });

  it("walks 120 chats in pages of 50, 50 and 20 with no gap and no repeat, ending with a null cursor", async () => {
    const chats = Array.from({ length: 120 }, (_, i) => ({ id: `c${String(i).padStart(3, "0")}`, seconds: i }));
    await seed("u1", chats);
    const pages = await walk("u1", 50);
    expect(pages.map((p) => p.length)).toEqual([50, 50, 20]);
    expect(pages.flat()).toEqual(canonical(chats));
  });

  it("gives no cursor when the last page is exactly full (no phantom empty page)", async () => {
    await seed("u1", Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, seconds: i })));
    const res = await listPage("u1", { limit: 10 });
    expect(listBody(res).chats).toHaveLength(10);
    expect(listBody(res).cursor).toBeNull();
  });

  it("returns a cursor when exactly one more chat exists", async () => {
    await seed("u1", Array.from({ length: 11 }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, seconds: i })));
    expect(listBody(await listPage("u1", { limit: 10 })).cursor).toEqual(expect.any(String));
  });

  it("walks heavy ties (every chat has the same timestamp) one at a time without skipping any", async () => {
    const chats = Array.from({ length: 30 }, (_, i) => ({ id: `t${String(i).padStart(2, "0")}`, seconds: 42 }));
    await seed("u1", chats);
    const pages = await walk("u1", 1);
    expect(pages.flat()).toEqual(canonical(chats));
    expect(pages).toHaveLength(30);
  });

  it("matches the canonical order for random data (pins and ties included) at many page sizes", async () => {
    const random = prng(20260930);
    const chats: Seed[] = Array.from({ length: 80 }, (_, i) => ({
      id: `r${String(i).padStart(3, "0")}`,
      seconds: Math.floor(random() * 12) * 60, // only 12 distinct times, so there are many ties
      pinned: random() < 0.25,
    }));
    await seed("u1", chats);
    for (const limit of [1, 2, 3, 7, 13, 50, 79, 80, 100]) {
      const pages = await walk("u1", limit);
      expect(pages.flat(), `limit ${limit}`).toEqual(canonical(chats));
      expect(new Set(pages.flat()).size).toBe(80);
    }
  });
});

describe("GET /api/chats: paging while things change", () => {
  const base: Seed[] = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, seconds: (10 - i) * 100 })); // c0 newest ... c9 oldest

  it("carries on correctly when the chat the cursor points at is deleted", async () => {
    await seed("u1", base);
    const first = listBody(await listPage("u1", { limit: 4 }));
    expect(first.chats.map((c) => c.id)).toEqual(["c0", "c1", "c2", "c3"]);
    await as("u1").delete("/api/chats/c3"); // the last chat of page one
    const second = listBody(await listPage("u1", { limit: 4, cursor: first.cursor as string }));
    expect(second.chats.map((c) => c.id)).toEqual(["c4", "c5", "c6", "c7"]);
  });

  it("does not repeat or lose chats when a new chat is created between pages", async () => {
    await seed("u1", base);
    const first = listBody(await listPage("u1", { limit: 4 }));
    const created = createdId(await as("u1").post("/api/chats").send({ title: "Brand new" }));
    const rest = (await walkFrom("u1", 4, first.cursor as string)).flat();
    expect(rest).toEqual(["c4", "c5", "c6", "c7", "c8", "c9"]);
    expect(rest).not.toContain(created); // it sorts above the cursor: a fresh first page shows it
    expect(idsOf(await listPage("u1"))[0]).toBe(created);
  });

  it("does not repeat a chat that was already served and then gets pinned", async () => {
    await seed("u1", base);
    const first = listBody(await listPage("u1", { limit: 4 }));
    await as("u1").patch("/api/chats/c1").send({ isPinned: true }); // already on page one
    const rest = (await walkFrom("u1", 4, first.cursor as string)).flat();
    expect(rest).toEqual(["c4", "c5", "c6", "c7", "c8", "c9"]);
  });

  it("keeps a chat that is pinned before it is reached out of the later pages (it is on the first page now)", async () => {
    await seed("u1", base);
    const first = listBody(await listPage("u1", { limit: 4 }));
    await as("u1").patch("/api/chats/c8").send({ isPinned: true });
    const rest = (await walkFrom("u1", 4, first.cursor as string)).flat();
    expect(rest).not.toContain("c8");
    expect(idsOf(await listPage("u1"))[0]).toBe("c8");
  });

  it("never errors when paging through a list that is being emptied", async () => {
    await seed("u1", base);
    const first = listBody(await listPage("u1", { limit: 3 }));
    await prisma.chat.deleteMany({ where: { userId: "u1" } });
    const after = await listPage("u1", { limit: 3, cursor: first.cursor as string });
    expect(after.status).toBe(200);
    expect(listBody(after)).toEqual({ chats: [], cursor: null });
  });

  it("pages from a cursor that sits inside the pinned block into the unpinned ones", async () => {
    const chats: Seed[] = [
      { id: "p1", seconds: 500, pinned: true },
      { id: "p2", seconds: 400, pinned: true },
      { id: "p3", seconds: 300, pinned: true },
      { id: "u1x", seconds: 200 },
      { id: "u2x", seconds: 100 },
    ];
    await seed("u1", chats);
    const pages = await walk("u1", 2); // the cursor after p2 is a pinned row
    expect(pages).toEqual([["p1", "p2"], ["p3", "u1x"], ["u2x"]]);
  });
});

async function walkFrom(user: string, limit: number, firstCursor: string): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | null = firstCursor;
  do {
    const res = await listPage(user, { limit, cursor });
    expect(res.status).toBe(200);
    const body = ChatListResponseSchema.parse(res.body);
    pages.push(body.chats.map((c) => c.id));
    cursor = body.cursor;
  } while (cursor);
  return pages;
}

describe("GET /api/chats: cursors", () => {
  const payload = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const good = ["2026-06-01T00:10:00.000Z"] as const;

  it.each([
    ["garbage", "!!!***"],
    ["base64 of text", payload("hello")],
    ["an empty tuple", payload([])],
    ["wrong arity", payload([0, good[0]])],
    ["pinned flag out of range", payload([2, good[0], "x"])],
    ["not a date", payload([0, "yesterday", "x"])],
    ["year 0000 (the database would reject it)", payload([0, "0000-01-01T00:00:00.000Z", "x"])],
    ["year 9999", payload([0, "9999-12-31T23:59:59.999Z", "x"])],
    ["id too long", payload([0, good[0], "x".repeat(65)])],
    ["NUL in the id", payload([0, good[0], "a\u0000b"])],
    ["id as a number", payload([0, good[0], 7])],
    ["oversized", "a".repeat(513)],
  ])("rejects a bad cursor with 400 and no data: %s", async (_label, cursor) => {
    await seed("u1", [{ id: "a", seconds: 1 }]);
    const res = await listPage("u1", { cursor });
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body)).toMatchObject({ code: "VALIDATION_FAILED" });
    expect((res.body as Partial<ListBody>).chats).toBeUndefined();
  });

  it("rejects an empty cursor and a repeated cursor parameter", async () => {
    expect((await as("u1").get("/api/chats?cursor=")).status).toBe(400);
    expect((await as("u1").get("/api/chats?cursor=a&cursor=b")).status).toBe(400);
  });

  it("returns an empty last page for a cursor past the end", async () => {
    await seed("u1", [{ id: "a", seconds: 100 }, { id: "b", seconds: 200 }]);
    const res = await listPage("u1", { cursor: encodeCursor([0, "2000-01-01T00:00:00.000Z", "a"]) });
    expect(listBody(res)).toEqual({ chats: [], cursor: null });
  });

  it("returns everything for a cursor far in the future", async () => {
    await seed("u1", [{ id: "a", seconds: 100 }, { id: "b", seconds: 200 }]);
    const res = await listPage("u1", { cursor: encodeCursor([0, "2150-01-01T00:00:00.000Z", "zzz"]) });
    expect(idsOf(res)).toEqual(["b", "a"]);
  });

  it("uses someone else's cursor only as a position in the caller's own list, leaking nothing", async () => {
    await seed("owner", Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, seconds: i * 10 })));
    await seed("me", [{ id: "m1", seconds: 15 }, { id: "m2", seconds: 55 }]);
    const theirs = listBody(await listPage("owner", { limit: 3 })).cursor as string;
    const res = await listPage("me", { cursor: theirs });
    expect(res.status).toBe(200);
    for (const chat of listBody(res).chats) expect(chat.userId).toBe("me");
    expect(JSON.stringify(res.body)).not.toMatch(/"o\d"/);
  });

  it("returns a fresh, valid cursor each page that decodes back to the last chat served", async () => {
    await seed("u1", Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, seconds: i })));
    const cursor = listBody(await listPage("u1", { limit: 2 })).cursor as string;
    const [pinned, when, id] = JSON.parse(Buffer.from(cursor, "base64url").toString()) as [number, string, string];
    expect([pinned, id]).toEqual([0, "c4"]);
    expect(when).toBe(at(4).toISOString());
  });
});

describe("operations racing each other", () => {
  it("never produces a server error when renames, deletes, creates and lists overlap", async () => {
    await seed("u1", Array.from({ length: 12 }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, seconds: i })));
    const operations = [
      ...Array.from({ length: 12 }, (_, i) => as("u1").patch(`/api/chats/c${String(i).padStart(2, "0")}`).send({ title: `renamed ${i}`, isPinned: i % 2 === 0 })),
      ...Array.from({ length: 6 }, (_, i) => as("u1").delete(`/api/chats/c${String(i).padStart(2, "0")}`)),
      ...Array.from({ length: 6 }, () => as("u1").post("/api/chats").send({})),
      ...Array.from({ length: 6 }, () => as("u1").get("/api/chats").query({ limit: 5 })),
    ];
    const statuses = (await Promise.all(operations)).map((r) => r.status);
    expect(statuses.filter((code) => code >= 500)).toEqual([]);
    expect(statuses.every((code) => [200, 201, 204, 404].includes(code))).toBe(true);
    // what is left is consistent: the six deleted chats are gone, the six created ones exist
    expect(await prisma.chat.count({ where: { id: { in: ["c00", "c01", "c02", "c03", "c04", "c05"] } } })).toBe(0);
    expect(await prisma.chat.count({ where: { userId: "u1" } })).toBe(12);
  });

  it("answers a rename that races a delete with 200 or 404, never an error", async () => {
    for (let round = 0; round < 8; round++) {
      const id = createdId(await as("u1").post("/api/chats").send({}));
      const [patched, deleted] = await Promise.all([as("u1").patch(`/api/chats/${id}`).send({ title: "x" }), as("u1").delete(`/api/chats/${id}`)]);
      expect([200, 404]).toContain(patched.status);
      expect(deleted.status).toBe(204);
    }
  });

  it("walks the whole list correctly while chats are being created and deleted around it", async () => {
    const chats = Array.from({ length: 40 }, (_, i) => ({ id: `w${String(i).padStart(2, "0")}`, seconds: 1000 - i }));
    await seed("u1", chats);
    const walking = walk("u1", 6);
    const churn = Promise.all([
      ...Array.from({ length: 8 }, () => as("u1").post("/api/chats").send({})),
      ...["w35", "w36", "w37", "w38", "w39"].map((id) => as("u1").delete(`/api/chats/${id}`)),
    ]);
    const [pages] = await Promise.all([walking, churn]);
    const seen = pages.flat();
    expect(new Set(seen).size).toBe(seen.length); // nothing served twice
    // every chat that stayed put for the whole walk was served, in order
    const stable = canonical(chats.filter((c) => !["w35", "w36", "w37", "w38", "w39"].includes(c.id)));
    expect(seen.filter((id) => stable.includes(id))).toEqual(stable);
  });
});

describe("the list query itself (the SQL Prisma really sends)", () => {
  // A second client that records every statement, so these tests look at the real query, not a hand-written copy.
  async function recordedQueries(run: (db: PrismaClient) => Promise<unknown>) {
    const statements: { query: string; params: string }[] = [];
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }), log: [{ emit: "event", level: "query" }] });
    db.$on("query", (event) => statements.push({ query: event.query, params: event.params }));
    try {
      await run(db);
    } finally {
      await db.$disconnect();
    }
    return statements.filter((s) => /FROM "public"\."Chat"/.test(s.query) && /ORDER BY/.test(s.query));
  }

  const pinnedCursor = encodeCursor([1, "2026-06-01T00:05:00.000Z", "c3"]);
  const unpinnedCursor = encodeCursor([0, "2026-06-01T00:05:00.000Z", "c3"]);

  it.each([
    ["first page", undefined],
    ["after an unpinned chat", unpinnedCursor],
    ["after a pinned chat", pinnedCursor],
  ])("orders by pinned, then activity, then id, all descending, with a row limit (%s)", async (_label, cursor) => {
    await seed("u1", [{ id: "a", seconds: 1 }]);
    const [statement] = await recordedQueries((db) => listChats("u1", { limit: 50, ...(cursor && { cursor }) }, db));
    expect(statement?.query).toMatch(/ORDER BY [^\n]*"isPinned" DESC[^\n]*"lastMessageAt" DESC[^\n]*"id" DESC/);
    expect(statement?.query).toMatch(/LIMIT/);
    expect(statement?.query).toMatch(/"userId" = \$1/); // always scoped to the caller
  });

  it.each([
    ["first page", undefined],
    ["after an unpinned chat", unpinnedCursor],
    ["after a pinned chat", pinnedCursor],
  ])("is served from the composite index in order, with no sort and no table scan (%s)", async (_label, cursor) => {
    await seed("u1", [{ id: "a", seconds: 1 }]);
    const [statement] = await recordedQueries((db) => listChats("u1", { limit: 50, ...(cursor && { cursor }) }, db));
    expect(statement).toBeDefined();
    const params = JSON.parse(statement?.params ?? "[]") as unknown[];

    const plan = await prisma.$transaction(async (tx) => {
      // forbid every other way of producing this order, so the plan only succeeds if the index can serve it
      for (const knob of ["enable_seqscan", "enable_bitmapscan", "enable_sort"]) await tx.$executeRawUnsafe(`SET LOCAL ${knob} = off`);
      const rows = await tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${statement?.query ?? ""}`, ...params);
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("Chat_userId_isPinned_lastMessageAt_id_idx");
    expect(plan).not.toMatch(/\bSort\b/);
    expect(plan).not.toContain("Seq Scan");
  });
});
