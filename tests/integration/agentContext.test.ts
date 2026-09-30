import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "#src/db/client.js";
import { CONTEXT_CHAR_BUDGET, CONTEXT_MESSAGE_LIMIT, loadConversation } from "#src/agent/context.js";
import { fixtures, resetDb } from "../helpers/db.js";

beforeEach(resetDb);

type Row = { role: "USER" | "ASSISTANT"; content: string | null; status?: "COMPLETED" | "FAILED" | "CANCELLED" | "STREAMING"; at: number; id?: string };
const T0 = Date.UTC(2026, 0, 1);

async function setup(rows: Row[]) {
  const user = await fixtures.user();
  const chat = await fixtures.chat(user.id);
  const ids: string[] = [];
  for (const row of rows) {
    const made = await prisma.message.create({
      data: { ...(row.id && { id: row.id }), chatId: chat.id, userId: user.id, role: row.role, content: row.content, status: row.status ?? "COMPLETED", createdAt: new Date(T0 + row.at * 1000) },
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
