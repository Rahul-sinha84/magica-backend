import { beforeEach, describe, expect, it } from "vitest";
import { ChatListResponseSchema, ChatSearchResponseSchema, ErrorResponseSchema } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { encodeCursor } from "#src/lib/cursor.js";
import { containsPattern } from "#src/services/chats.js";
import { anonymous, as } from "../helpers/app.js";
import { resetDb } from "../helpers/db.js";

beforeEach(resetDb);

const T0 = new Date("2026-06-01T00:00:00.000Z").getTime();
const at = (seconds: number) => new Date(T0 + seconds * 1000);

interface Seed {
  id: string;
  title?: string;
  seconds: number; // lastMessageAt, as an offset so ties are easy to make
  pinned?: boolean;
  messages?: (string | null)[];
}

/** Chats with exact ids, titles, timestamps and message texts, so matching and ordering are fully deterministic. */
async function seed(userId: string, chats: Seed[]) {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, balance: 1_000_000 } });
  for (const c of chats) {
    await prisma.chat.create({ data: { id: c.id, userId, title: c.title ?? "New chat", isPinned: c.pinned ?? false, lastMessageAt: at(c.seconds), createdAt: at(c.seconds) } });
    if (c.messages?.length) {
      await prisma.message.createMany({ data: c.messages.map((content, i) => ({ chatId: c.id, userId, role: i % 2 ? "ASSISTANT" : "USER", content, createdAt: at(c.seconds - 100 + i) })) });
    }
  }
}

async function search(userId: string, query: Record<string, string | number>) {
  const res = await as(userId).get("/api/chats/search").query(query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ChatSearchResponseSchema.parse(res.body);
}
const ids = (body: { chats: { id: string }[] }) => body.chats.map((chat) => chat.id);

async function rejected(userId: string, query: Record<string, string | number>) {
  const res = await as(userId).get("/api/chats/search").query(query);
  expect(res.status).toBe(400);
  return ErrorResponseSchema.parse(res.body);
}

describe("GET /api/chats/search: what matches", () => {
  it("needs a signed-in user", async () => {
    expect((await anonymous().get("/api/chats/search").query({ q: "sunset" })).status).toBe(401);
  });

  it("is a route of its own, not a chat called 'search'", async () => {
    await seed("u1", [{ id: "c1", title: "Sunset ideas", seconds: 1 }]);
    expect(ids(await search("u1", { q: "sunset" }))).toEqual(["c1"]);
  });

  it("matches titles, ignoring case", async () => {
    await seed("u1", [
      { id: "c1", title: "Sunset over the BAY", seconds: 1 },
      { id: "c2", title: "Mountains", seconds: 2 },
    ]);
    expect(ids(await search("u1", { q: "bay" }))).toEqual(["c1"]);
    expect(ids(await search("u1", { q: "SUNSET" }))).toEqual(["c1"]);
  });

  it("matches a word that only appears inside a message, from either side of the conversation", async () => {
    await seed("u1", [
      { id: "c1", title: "Why the Sky is Blue", seconds: 1, messages: ["why is the sky blue?", "Because of Rayleigh scattering."] },
      { id: "c2", title: "Other", seconds: 2, messages: ["nothing here"] },
    ]);
    expect(ids(await search("u1", { q: "rayleigh" }))).toEqual(["c1"]);
    expect(ids(await search("u1", { q: "sky blue" }))).toEqual(["c1"]);
  });

  it("returns a chat once, however many of its messages match", async () => {
    await seed("u1", [{ id: "c1", title: "Fox", seconds: 1, messages: Array.from({ length: 40 }, (_, i) => `red fox number ${i}`) }]);
    expect(ids(await search("u1", { q: "red fox" }))).toEqual(["c1"]);
  });

  it("never returns another user's chats, by title or by message", async () => {
    await seed("u1", [{ id: "mine", title: "Unrelated", seconds: 1, messages: ["hello"] }]);
    await seed("u2", [{ id: "theirs", title: "secret plan", seconds: 2, messages: ["the secret plan is here"] }]);
    expect(await search("u1", { q: "secret" })).toEqual({ chats: [], cursor: null });
    expect(ids(await search("u2", { q: "secret" }))).toEqual(["theirs"]);
  });

  it("takes %, _ and \\ literally", async () => {
    await seed("u1", [
      { id: "pct", title: "Done 100% today", seconds: 1 },
      { id: "nopct", title: "Done 1000 today", seconds: 2 },
      { id: "under", title: "file_name.png", seconds: 3 },
      { id: "nounder", title: "fileXname.png", seconds: 4 },
      { id: "slash", title: "C:\\temp\\out", seconds: 5 },
      { id: "noslash", title: "C:temp out", seconds: 6 },
    ]);
    expect(ids(await search("u1", { q: "100%" }))).toEqual(["pct"]);
    expect(ids(await search("u1", { q: "e_n" }))).toEqual(["under"]);
    expect(ids(await search("u1", { q: ":\\te" }))).toEqual(["slash"]);
    expect(await search("u1", { q: "%%%" })).toEqual({ chats: [], cursor: null });
  });

  it("matches accented and non-Latin text, ignoring case, and emoji", async () => {
    await seed("u1", [
      { id: "cafe", title: "Café crème recipe", seconds: 1 },
      { id: "ja", title: "日本語のメモ", seconds: 2 },
      { id: "emoji", title: "Launch 🚀 day", seconds: 3 },
    ]);
    expect(ids(await search("u1", { q: "café" }))).toEqual(["cafe"]);
    expect(ids(await search("u1", { q: "CAFÉ" }))).toEqual(["cafe"]);
    expect(ids(await search("u1", { q: "日本語" }))).toEqual(["ja"]);
    expect(ids(await search("u1", { q: "🚀 d" }))).toEqual(["emoji"]);
  });

  it("trims the query, and skips messages that have no text yet (a reply still being written)", async () => {
    await seed("u1", [{ id: "c1", title: "Plan", seconds: 1, messages: ["draft the launch email", null] }]);
    expect(ids(await search("u1", { q: "  launch  " }))).toEqual(["c1"]);
  });

  it("is empty for an account with no chats", async () => {
    expect(await search("nobody", { q: "anything" })).toEqual({ chats: [], cursor: null });
  });
});

describe("GET /api/chats/search: order and pages", () => {
  it("lists newest activity first, id breaking ties, and shows pinned state without moving pinned chats up", async () => {
    await seed("u1", [
      { id: "a", title: "match old", seconds: 1, pinned: true },
      { id: "b", title: "match tie", seconds: 5 },
      { id: "c", title: "match tie", seconds: 5 },
      { id: "d", title: "match new", seconds: 9 },
    ]);
    const body = await search("u1", { q: "match" });
    expect(ids(body)).toEqual(["d", "c", "b", "a"]);
    expect(body.chats.find((chat) => chat.id === "a")?.isPinned).toBe(true);
  });

  it("returns each chat exactly as the chat list does (same fields, same timestamps, whatever the server's time zone)", async () => {
    await seed("u1", [
      { id: "a", title: "match one", seconds: 1, pinned: true },
      { id: "b", title: "other", seconds: 2, messages: ["a match inside"] },
    ]);
    const found = await search("u1", { q: "match" });
    const listed = ChatListResponseSchema.parse((await as("u1").get("/api/chats")).body);
    for (const chat of found.chats) expect(chat).toEqual(listed.chats.find((c) => c.id === chat.id));
    expect(found.chats.find((c) => c.id === "b")?.lastMessageAt).toBe(at(2).toISOString());
  });

  it("pages through every match exactly once, then ends", async () => {
    await seed("u1", [
      { id: "a", title: "match", seconds: 1 },
      { id: "b", title: "match", seconds: 3 },
      { id: "c", title: "match", seconds: 3 },
      { id: "d", title: "skip", seconds: 4, messages: ["a match in a message"] },
      { id: "e", title: "match", seconds: 7 },
      { id: "f", title: "no", seconds: 8 },
    ]);
    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 10; page++) {
      const body = await search("u1", { q: "match", limit: 2, ...(cursor && { cursor }) });
      expect(body.chats.length).toBeLessThanOrEqual(2);
      seen.push(...ids(body));
      cursor = body.cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(["e", "d", "c", "b", "a"]);
  });

  it("carries on correctly when the chat a page ended on is deleted before the next page", async () => {
    await seed("u1", [
      { id: "a", title: "match", seconds: 1 },
      { id: "b", title: "match", seconds: 2 },
      { id: "c", title: "match", seconds: 3 },
    ]);
    const first = await search("u1", { q: "match", limit: 2 });
    expect(ids(first)).toEqual(["c", "b"]);
    await prisma.chat.delete({ where: { id: "b" } });
    expect(ids(await search("u1", { q: "match", limit: 2, cursor: first.cursor! }))).toEqual(["a"]);
  });

  it("follows a rename between pages (a renamed chat that no longer matches drops out)", async () => {
    await seed("u1", [
      { id: "a", title: "match", seconds: 1 },
      { id: "b", title: "match", seconds: 2 },
      { id: "c", title: "match", seconds: 3 },
    ]);
    const first = await search("u1", { q: "match", limit: 1 });
    await prisma.chat.update({ where: { id: "b" }, data: { title: "renamed" } });
    expect(ids(await search("u1", { q: "match", limit: 5, cursor: first.cursor! }))).toEqual(["a"]);
  });
});

describe("GET /api/chats/search: bad input", () => {
  it.each([
    ["missing", {}],
    ["too short", { q: "ab" }],
    ["too short once trimmed", { q: "  ab  " }],
    ["only spaces", { q: "      " }],
    ["too long", { q: "x".repeat(101) }],
    ["a NUL character", { q: "abc\u0000" }],
    ["a page size over 50", { q: "abc", limit: 51 }],
    ["a page size of 0", { q: "abc", limit: 0 }],
  ])("rejects %s with a 400", async (_label, query) => {
    await rejected("u1", query);
  });

  it("explains a short query in words the user can act on", async () => {
    expect((await rejected("u1", { q: "ab" })).error).toMatch(/at least 3 characters/);
  });

  it("accepts exactly 3 and exactly 100 characters", async () => {
    await search("u1", { q: "abc" });
    await search("u1", { q: "y".repeat(100) });
  });

  it.each([
    ["garbage", "not-a-cursor"],
    ["a chat-list cursor (a different shape)", encodeCursor([0, "2026-06-01T00:00:00.000Z", "abc"])],
    ["an impossible date", encodeCursor(["0000-01-01T00:00:00.000Z", "abc"])],
    ["an id that can't exist", encodeCursor(["2026-06-01T00:00:00.000Z", "../../etc"])],
  ])("rejects %s as the cursor with a 400, never a 500", async (_label, cursor) => {
    await rejected("u1", { q: "match", cursor });
  });
});

describe("the search uses the trigram indexes", () => {
  // Small tables are cheaper to scan, so the planner is told to avoid scans; what matters is that the index CAN serve
  // these queries (an ILIKE that doesn't fit the operator class would fall back to a scan regardless).
  async function plan(sql: string, params: string[]) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      const rows = await tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${sql}`, ...params);
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
  }

  // (with real data the planner combines this with the user index below: a rare term through the trigram index, a
  // common one through the caller's own messages; measured on 200,000 messages at under 1 ms and 3 ms)
  it("on message content", async () => {
    expect(await plan(`SELECT "chatId" FROM "Message" WHERE "content" ILIKE $1`, [containsPattern("rayleigh")])).toContain("Message_content_trgm_idx");
  });

  it("and can read just the caller's messages, so a term that matches nearly everything never scans other users' messages", async () => {
    expect(await plan(`SELECT "chatId" FROM "Message" WHERE "userId" = $1`, ["u1"])).toContain("Message_userId_idx");
  });

  it("on chat titles", async () => {
    expect(await plan(`SELECT "id" FROM "Chat" WHERE "title" ILIKE $1`, [containsPattern("sunset")])).toContain("Chat_title_trgm_idx");
  });
});

describe("containsPattern", () => {
  it.each([
    ["sunset", "%sunset%"],
    ["100%", "%100\\%%"],
    ["a_b", "%a\\_b%"],
    ["C:\\temp", "%C:\\\\temp%"],
  ])("%j becomes %j", (input, pattern) => {
    expect(containsPattern(input)).toBe(pattern);
  });
});
