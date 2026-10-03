import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "#src/db/client.js";
import { CONTEXT_CHAR_BUDGET, CONTEXT_MESSAGE_LIMIT, loadConversation, renderQuestion } from "#src/agent/context.js";
import { fixtures, resetDb } from "../helpers/db.js";

beforeEach(resetDb);

type Row = { role: "USER" | "ASSISTANT"; content: string | null; status?: "COMPLETED" | "FAILED" | "CANCELLED" | "STREAMING"; at: number; id?: string; blocks?: unknown[] };
const T0 = Date.UTC(2026, 0, 1);

async function setup(rows: Row[]) {
  const user = await fixtures.user();
  const chat = await fixtures.chat(user.id);
  const ids: string[] = [];
  for (const row of rows) {
    const made = await prisma.message.create({
      data: { ...(row.id && { id: row.id }), chatId: chat.id, userId: user.id, role: row.role, content: row.content, status: row.status ?? "COMPLETED", createdAt: new Date(T0 + row.at * 1000), ...(row.blocks && { contentBlocks: row.blocks as never }) },
    });
    ids.push(made.id);
  }
  return { user, chat, ids };
}

describe("loadConversation", () => {
  it("returns the conversation up to and including the question, oldest first", async () => {
    const { chat, ids } = await setup([
      { role: "USER", content: "q1", at: 1 },
      { role: "ASSISTANT", content: "a1", at: 2 },
      { role: "USER", content: "q2", at: 3 },
      { role: "ASSISTANT", content: null, status: "STREAMING", at: 4 },
    ]);
    expect(await loadConversation(chat.id, ids[2]!)).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
  });

  it("does not include anything after the question, so a retry sees what the first attempt saw", async () => {
    const { chat, ids } = await setup([
      { role: "USER", content: "q1", at: 1 },
      { role: "ASSISTANT", content: "a1", at: 2 },
      { role: "USER", content: "q2", at: 3 },
      { role: "ASSISTANT", content: "a2", at: 4 },
      { role: "USER", content: "q3", at: 5 },
    ]);
    const conversation = await loadConversation(chat.id, ids[2]!);
    expect(conversation.map((m) => m.content)).toEqual(["q1", "a1", "q2"]);
  });

  it("leaves out failed, cancelled and unfinished replies, and replies with no text", async () => {
    const { chat, ids } = await setup([
      { role: "USER", content: "q1", at: 1 },
      { role: "ASSISTANT", content: "partial", status: "FAILED", at: 2 },
      { role: "USER", content: "q2", at: 3 },
      { role: "ASSISTANT", content: "half", status: "CANCELLED", at: 4 },
      { role: "ASSISTANT", content: null, at: 5 },
      { role: "USER", content: "q3", at: 6 },
    ]);
    expect(await loadConversation(chat.id, ids[5]!)).toEqual([{ role: "user", content: "q1\n\nq2\n\nq3" }]);
  });

  it("drops a leading assistant message, since a conversation starts with a person", async () => {
    const { chat, ids } = await setup([
      { role: "ASSISTANT", content: "welcome", at: 1 },
      { role: "USER", content: "hi", at: 2 },
    ]);
    expect(await loadConversation(chat.id, ids[1]!)).toEqual([{ role: "user", content: "hi" }]);
  });

  it("keeps messages with identical timestamps in a stable order, and a same-instant later id out", async () => {
    const { chat, ids } = await setup([
      { role: "USER", content: "first", at: 1, id: "m_a" },
      { role: "ASSISTANT", content: "second", at: 1, id: "m_b" },
      { role: "USER", content: "question", at: 1, id: "m_c" },
      { role: "ASSISTANT", content: "after", at: 1, id: "m_d" },
    ]);
    expect((await loadConversation(chat.id, ids[2]!)).map((m) => m.content)).toEqual(["first", "second", "question"]);
  });

  it("only reads the chat it is asked about", async () => {
    const one = await setup([{ role: "USER", content: "mine", at: 1 }]);
    const other = await setup([{ role: "USER", content: "theirs", at: 0 }]);
    expect(await loadConversation(one.chat.id, one.ids[0]!)).toEqual([{ role: "user", content: "mine" }]);
    expect(await loadConversation(one.chat.id, other.ids[0]!)).toEqual([]); // a question from another chat is not found
    expect(await loadConversation(one.chat.id, "nosuchmessage")).toEqual([]);
  });

  it(`keeps at most ${CONTEXT_MESSAGE_LIMIT} messages, the newest ones`, async () => {
    const rows: Row[] = Array.from({ length: 150 }, (_, i) => ({ role: i % 2 === 0 ? "USER" : "ASSISTANT", content: `m${i}`, at: i + 1 }));
    rows.push({ role: "USER", content: "last", at: 200 });
    const { chat, ids } = await setup(rows);
    const conversation = await loadConversation(chat.id, ids[ids.length - 1]!);
    const texts = conversation.flatMap((m) => m.content.split("\n\n"));
    expect(texts.length).toBeLessThanOrEqual(CONTEXT_MESSAGE_LIMIT);
    expect(texts.at(-1)).toBe("last");
    expect(texts).not.toContain("m0");
  });

  it("fits the character budget by dropping the oldest, and always keeps the question", async () => {
    const big = "x".repeat(CONTEXT_BUDGET_PART());
    const { chat, ids } = await setup([
      { role: "USER", content: "old question", at: 1 },
      { role: "ASSISTANT", content: big, at: 2 },
      { role: "USER", content: big, at: 3 },
      { role: "ASSISTANT", content: big, at: 4 },
      { role: "USER", content: "latest", at: 5 },
    ]);
    const conversation = await loadConversation(chat.id, ids[4]!);
    const total = conversation.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(CONTEXT_CHAR_BUDGET + 4);
    expect(conversation.at(-1)?.content).toContain("latest");
    expect(conversation.map((m) => m.content)).not.toContain("old question");
  });

  it("keeps the question even when it alone is over the budget", async () => {
    const huge = "y".repeat(CONTEXT_CHAR_BUDGET * 2);
    const { chat, ids } = await setup([
      { role: "USER", content: "earlier", at: 1 },
      { role: "USER", content: huge, at: 2 },
    ]);
    expect(await loadConversation(chat.id, ids[1]!)).toEqual([{ role: "user", content: huge }]);
  });

  it("joins consecutive messages from the same person so speakers alternate", async () => {
    const { chat, ids } = await setup([
      { role: "USER", content: "a", at: 1 },
      { role: "USER", content: "b", at: 2 },
      { role: "ASSISTANT", content: "c", at: 3 },
      { role: "USER", content: "d", at: 4 },
    ]);
    expect(await loadConversation(chat.id, ids[3]!)).toEqual([
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "c" },
      { role: "user", content: "d" },
    ]);
  });
});

function CONTEXT_BUDGET_PART(): number {
  return Math.floor(CONTEXT_CHAR_BUDGET * 0.45);
}

describe("earlier media and tool results in the history", () => {
  const IMG = "https://g.tlcdn.com/gen/fox.png";
  const image = { type: "image", url: IMG, model: "GPT Image 2" };

  it("tells the model about an image an earlier reply created, so a follow-up can refer to it", async () => {
    const { chat, ids } = await setup([
      { role: "USER", content: "Draw a fox", at: 1 },
      { role: "ASSISTANT", content: "Here is your fox.", at: 2, blocks: [{ type: "text", content: "Here is your fox." }, image] },
      { role: "USER", content: "Crop it to the top half", at: 3 },
    ]);
    expect(await loadConversation(chat.id, ids[2]!)).toEqual([
      { role: "user", content: "Draw a fox" },
      { role: "assistant", content: `Here is your fox.\n[Generated image: ${IMG}]` },
      { role: "user", content: "Crop it to the top half" },
    ]);
  });

  it("keeps a reply that is only an image (no text at all)", async () => {
    const { chat, ids } = await setup([
      { role: "USER", content: "Draw a fox", at: 1 },
      { role: "ASSISTANT", content: "", at: 2, blocks: [image] },
      { role: "USER", content: "Now crop it", at: 3 },
    ]);
    expect((await loadConversation(chat.id, ids[2]!))[1]).toEqual({ role: "assistant", content: `[Generated image: ${IMG}]` });
  });

  it("keeps the media of a failed or stopped reply, but never its partial text", async () => {
    const { chat, ids } = await setup([
      { role: "USER", content: "Draw then merge", at: 1 },
      { role: "ASSISTANT", content: "Half an ans", status: "FAILED", at: 2, blocks: [{ type: "text", content: "Half an ans" }, image] },
      { role: "USER", content: "Use that image", at: 3 },
      { role: "ASSISTANT", content: "Stopped mid", status: "CANCELLED", at: 4, blocks: [{ type: "text", content: "Stopped mid" }, { type: "video", url: "https://a.test/v.mp4" }] },
      { role: "USER", content: "And the video", at: 5 },
    ]);
    const history = await loadConversation(chat.id, ids[4]!);
    expect(history.map((m) => m.content).join("\n")).not.toMatch(/Half an ans|Stopped mid/);
    expect(history).toEqual([
      { role: "user", content: "Draw then merge" },
      { role: "assistant", content: `[Generated image: ${IMG}]` },
      { role: "user", content: "Use that image" },
      { role: "assistant", content: "[Generated video: https://a.test/v.mp4]" },
      { role: "user", content: "And the video" },
    ]);
  });

  it("notes which tool calls failed and why, but not successful tool details or thinking", async () => {
    const { chat, ids } = await setup([
      { role: "USER", content: "Crop it", at: 1 },
      {
        role: "ASSISTANT",
        content: "The crop failed.",
        at: 2,
        blocks: [
          { type: "thinking", content: "secret reasoning" },
          { type: "tool_call", toolCallId: "c1", toolName: "load_skill", toolInput: { name: "image-editing" }, status: "completed" },
          { type: "tool_result", toolCallId: "c1", toolName: "load_skill", result: { instructions: "LONG SKILL TEXT" }, isError: false },
          { type: "tool_call", toolCallId: "c2", toolName: "crop_image", toolInput: {}, status: "failed" },
          { type: "tool_result", toolCallId: "c2", toolName: "crop_image", isError: true, errorMessage: "Cropping timed out." },
          { type: "text", content: "The crop failed." },
          { type: "usage", inputTokens: 1, outputTokens: 1, model: "m" },
        ],
      },
      { role: "USER", content: "Try again", at: 3 },
    ]);
    const reply = (await loadConversation(chat.id, ids[2]!))[1]?.content ?? "";
    expect(reply).toBe("The crop failed.\n[crop_image failed: Cropping timed out.]");
    expect(reply).not.toMatch(/secret reasoning|LONG SKILL TEXT/);
  });

  it("names audio and video media correctly, in the order they were made", async () => {
    const { chat, ids } = await setup([
      { role: "USER", content: "Make media", at: 1 },
      { role: "ASSISTANT", content: "Done.", at: 2, blocks: [{ type: "text", content: "Done." }, { type: "video", url: "https://a.test/1.mp4" }, { type: "audio", url: "https://a.test/2.mp3" }, image] },
      { role: "USER", content: "Next", at: 3 },
    ]);
    expect((await loadConversation(chat.id, ids[2]!))[1]?.content).toBe(`Done.\n[Generated video: https://a.test/1.mp4]\n[Generated audio: https://a.test/2.mp3]\n[Generated image: ${IMG}]`);
  });

  it("counts the media lines against the character budget", async () => {
    const long = "x".repeat(CONTEXT_CHAR_BUDGET - 30);
    const { chat, ids } = await setup([
      { role: "USER", content: "First", at: 1 },
      { role: "ASSISTANT", content: "", at: 2, blocks: [image] },
      { role: "USER", content: long, at: 3 },
    ]);
    expect((await loadConversation(chat.id, ids[2]!)).map((m) => m.role)).toEqual(["user"]); // the image line didn't fit
  });

  it("still leaves out a failed reply that produced nothing usable", async () => {
    const { chat, ids } = await setup([
      { role: "USER", content: "q1", at: 1 },
      { role: "ASSISTANT", content: "partial", status: "FAILED", at: 2, blocks: [{ type: "text", content: "partial" }] },
      { role: "USER", content: "q2", at: 3 },
    ]);
    expect(await loadConversation(chat.id, ids[2]!)).toEqual([{ role: "user", content: "q1\n\nq2" }]);
  });

  it("uses an old reply's plain text when it has no blocks", async () => {
    const { chat, ids } = await setup([
      { role: "USER", content: "q1", at: 1 },
      { role: "ASSISTANT", content: "plain answer", at: 2 },
      { role: "USER", content: "q2", at: 3 },
    ]);
    expect((await loadConversation(chat.id, ids[2]!))[1]).toEqual({ role: "assistant", content: "plain answer" });
  });
});

describe("attached files", () => {
  const HOUR = 3_600_000;
  const asset = (userId: string, data: { type: "IMAGE" | "VIDEO" | "AUDIO"; url: string; expiresAt?: Date | null; source?: "UPLOAD" | "GENERATED" }) =>
    prisma.mediaAsset.create({ data: { userId, type: data.type, url: data.url, source: data.source ?? "UPLOAD", expiresAt: data.source === "GENERATED" ? null : (data.expiresAt ?? new Date(Date.now() + HOUR)) } });

  it("lists a question's files after its text, in order: a link for each live file, a note without one once expired", async () => {
    const { user, chat, ids } = await setup([{ role: "USER", content: "Crop the first", at: 1 }]);
    const live = await asset(user.id, { type: "IMAGE", url: "https://cdn.test/live.png" });
    const gone = await asset(user.id, { type: "VIDEO", url: "https://cdn.test/gone.mp4", expiresAt: new Date(Date.now() - 1_000) });
    const made = await asset(user.id, { type: "AUDIO", url: "https://cdn.test/made.mp3", source: "GENERATED" });
    await prisma.attachment.createMany({
      data: [
        { messageId: ids[0]!, mediaAssetId: gone.id, position: 1 },
        { messageId: ids[0]!, mediaAssetId: made.id, position: 2 },
        { messageId: ids[0]!, mediaAssetId: live.id, position: 0 },
      ],
    });
    expect(await loadConversation(chat.id, ids[0]!)).toEqual([
      { role: "user", content: "Crop the first\n[Attached image: https://cdn.test/live.png]\n[Attached video (expired)]\n[Attached audio: https://cdn.test/made.mp3]" },
    ]);
  });

  it("orders files by position even when the database doesn't read them in that order", async () => {
    // the (message, position) index happens to return position order; a table scan (large tables, other plans) returns
    // storage order, so the order must come from the query itself
    const { user, chat, ids } = await setup([{ role: "USER", content: "In order please", at: 1 }]);
    const files = await Promise.all(["third", "first", "second"].map((name) => asset(user.id, { type: "IMAGE", url: `https://cdn.test/${name}.png` })));
    await prisma.attachment.createMany({ data: [2, 0, 1].map((position, i) => ({ messageId: ids[0]!, mediaAssetId: files[i]!.id, position })) });
    const conversation = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_indexscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
      return loadConversation(chat.id, ids[0]!, tx);
    });
    expect(conversation[0]?.content).toBe("In order please\n[Attached image: https://cdn.test/first.png]\n[Attached image: https://cdn.test/second.png]\n[Attached image: https://cdn.test/third.png]");
  });

  it("judges expiry at the moment of the turn", async () => {
    const { user, chat, ids } = await setup([{ role: "USER", content: "Use it", at: 1 }]);
    const file = await asset(user.id, { type: "IMAGE", url: "https://cdn.test/soon.png", expiresAt: new Date(Date.now() + HOUR) });
    await prisma.attachment.create({ data: { messageId: ids[0]!, mediaAssetId: file.id, position: 0 } });
    expect((await loadConversation(chat.id, ids[0]!))[0]?.content).toContain("[Attached image: https://cdn.test/soon.png]");
    expect((await loadConversation(chat.id, ids[0]!, prisma, new Date(Date.now() + 2 * HOUR)))[0]?.content).toBe("Use it\n[Attached image (expired)]");
  });

  it("carries files of earlier questions too, so a follow-up can refer back to them", async () => {
    const { user, chat, ids } = await setup([
      { role: "USER", content: "Here is my photo", at: 1 },
      { role: "ASSISTANT", content: "Got it.", at: 2 },
      { role: "USER", content: "Now crop it", at: 3 },
    ]);
    const photo = await asset(user.id, { type: "IMAGE", url: "https://cdn.test/photo.png" });
    await prisma.attachment.create({ data: { messageId: ids[0]!, mediaAssetId: photo.id, position: 0 } });
    expect((await loadConversation(chat.id, ids[2]!))[0]?.content).toBe("Here is my photo\n[Attached image: https://cdn.test/photo.png]");
  });
});

describe("renderQuestion", () => {
  it("is just the text with no files, and just the files with no text", () => {
    expect(renderQuestion("hello", [])).toBe("hello");
    expect(renderQuestion("", [{ type: "IMAGE", url: "https://x/a.png", expiresAt: null }])).toBe("[Attached image: https://x/a.png]");
  });
});
