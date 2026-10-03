import { beforeEach, describe, expect, it } from "vitest";
import { ErrorResponseSchema, MediaListResponseSchema } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { encodeCursor } from "#src/lib/cursor.js";
import { anonymous, as } from "../helpers/app.js";
import { resetDb } from "../helpers/db.js";

beforeEach(resetDb);

const HOUR = 3_600_000;
const T0 = Date.now() - 48 * HOUR; // created times are offsets from here, in seconds
const at = (seconds: number) => new Date(T0 + seconds * 1000);

interface Seed {
  id: string;
  seconds: number;
  source?: "UPLOAD" | "GENERATED";
  name?: string;
  prompt?: string;
  expiresInHours?: number; // uploads: from now (negative = already expired)
}

async function seed(userId: string, rows: Seed[]) {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, balance: 1_000_000 } });
  for (const r of rows) {
    const upload = (r.source ?? "UPLOAD") === "UPLOAD";
    await prisma.mediaAsset.create({
      data: {
        id: r.id,
        userId,
        source: upload ? "UPLOAD" : "GENERATED",
        type: "IMAGE",
        url: `https://cdn.test/${r.id}.png`,
        createdAt: at(r.seconds),
        ...(upload ? { name: r.name ?? `${r.id}.png`, expiresAt: new Date(Date.now() + (r.expiresInHours ?? 20) * HOUR) } : { prompt: r.prompt ?? "a picture", model: "GPT Image 2" }),
      },
    });
  }
}

async function list(userId: string, query: Record<string, string | number> = {}) {
  const res = await as(userId).get("/api/media").query(query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return MediaListResponseSchema.parse(res.body);
}
const ids = (body: { media: { id: string }[] }) => body.media.map((m) => m.id);

describe("GET /api/media", () => {
  it("needs a signed-in user", async () => {
    expect((await anonymous().get("/api/media")).status).toBe(401);
  });

  it("lists the user's uploads and generated media, newest first, with how many files there are", async () => {
    await seed("u1", [
      { id: "old", seconds: 1 },
      { id: "gen", seconds: 2, source: "GENERATED", prompt: "a red fox" },
      { id: "new", seconds: 3 },
    ]);
    const body = await list("u1");
    expect(ids(body)).toEqual(["new", "gen", "old"]);
    expect(body.total).toBe(3);
    expect(body.cursor).toBeNull();
    expect(body.media[1]).toMatchObject({ source: "generated", type: "image", prompt: "a red fox", model: "GPT Image 2", name: null, expiresAt: null });
    expect(body.media[0]).toMatchObject({ source: "upload", name: "new.png", prompt: null });
  });

  it("leaves out expired uploads (and doesn't count them), but keeps generated media forever", async () => {
    await seed("u1", [
      { id: "live", seconds: 1, expiresInHours: 1 },
      { id: "gone", seconds: 2, expiresInHours: -1 },
      { id: "gen", seconds: 3, source: "GENERATED" },
    ]);
    const body = await list("u1");
    expect(ids(body)).toEqual(["gen", "live"]);
    expect(body.total).toBe(2);
  });

  it("filters by source", async () => {
    await seed("u1", [
      { id: "up", seconds: 1 },
      { id: "gen", seconds: 2, source: "GENERATED" },
    ]);
    expect(ids(await list("u1", { source: "upload" }))).toEqual(["up"]);
    expect(ids(await list("u1", { source: "generated" }))).toEqual(["gen"]);
  });

  it("searches file names and prompts, ignoring case, taking % and _ literally, within a source too", async () => {
    await seed("u1", [
      { id: "beach", seconds: 1, name: "Beach_Day.JPG" },
      { id: "fox", seconds: 2, source: "GENERATED", prompt: "A RED fox in snow" },
      { id: "pct", seconds: 3, name: "100% done.png" },
      { id: "other", seconds: 4, name: "notes.png" },
    ]);
    expect(ids(await list("u1", { q: "red fox" }))).toEqual(["fox"]);
    expect(ids(await list("u1", { q: "beach_day" }))).toEqual(["beach"]);
    expect(ids(await list("u1", { q: "notes_png" }))).toEqual([]); // _ is a character, not a wildcard ("notes.png" has a dot)
    expect(ids(await list("u1", { q: "100%" }))).toEqual(["pct"]);
    expect(ids(await list("u1", { q: "red", source: "upload" }))).toEqual([]);
    expect((await list("u1", { q: "red fox" })).total).toBe(4); // the header count is the whole library
  });

  it("treats an empty search box as no search", async () => {
    await seed("u1", [{ id: "a", seconds: 1 }]);
    expect(ids(await list("u1", { q: "" }))).toEqual(["a"]);
    expect(ids(await list("u1", { q: "   " }))).toEqual(["a"]);
  });

  it("never shows another user's files", async () => {
    await seed("u1", [{ id: "mine", seconds: 1 }]);
    await seed("u2", [{ id: "theirs", seconds: 2, name: "mine.png" }]);
    const body = await list("u1", { q: "mine" });
    expect(ids(body)).toEqual(["mine"]);
    expect(body.total).toBe(1);
  });

  it("pages through everything exactly once, ties broken by id", async () => {
    await seed("u1", [
      { id: "a", seconds: 1 },
      { id: "b", seconds: 2 },
      { id: "c", seconds: 2 },
      { id: "d", seconds: 3, source: "GENERATED" },
      { id: "e", seconds: 4 },
    ]);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const body: Awaited<ReturnType<typeof list>> = await list("u1", { limit: 2, ...(cursor && { cursor }) });
      seen.push(...ids(body));
      cursor = body.cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(["e", "d", "c", "b", "a"]);
  });

  it.each([
    ["a search under 3 characters", { q: "ab" }],
    ["an unknown source", { source: "favorites" }],
    ["a garbage cursor", { cursor: "nope" }],
    ["a chat-list cursor", { cursor: encodeCursor([0, "2026-06-01T00:00:00.000Z", "abc"]) }],
    ["a page size over 100", { limit: 101 }],
  ])("refuses %s with a 400", async (_label, query) => {
    const res = await as("u1").get("/api/media").query(query);
    expect(res.status).toBe(400);
    ErrorResponseSchema.parse(res.body);
  });
});
