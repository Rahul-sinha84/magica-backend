import { describe, expect, it } from "vitest";
import { ChatSchema } from "#src/contracts/index.js";
import { serializeChat } from "#src/services/serialize.js";

const row = {
  id: "chat_1",
  userId: "user_1",
  title: "Plans",
  isPinned: true,
  createdAt: new Date("2026-09-30T10:00:00.123Z"),
  updatedAt: new Date("2026-09-30T11:00:00.456Z"),
  lastMessageAt: new Date("2026-09-30T12:00:00.789Z"),
};

describe("serializeChat", () => {
  it("produces exactly the contract shape, with ISO timestamps that keep milliseconds", () => {
    const chat = serializeChat(row);
    expect(ChatSchema.parse(chat)).toEqual(chat);
    expect(chat).toEqual({
      id: "chat_1",
      userId: "user_1",
      title: "Plans",
      isPinned: true,
      createdAt: "2026-09-30T10:00:00.123Z",
      updatedAt: "2026-09-30T11:00:00.456Z",
      lastMessageAt: "2026-09-30T12:00:00.789Z",
    });
  });

  it("never leaks fields that are not in the contract", () => {
    expect(Object.keys(serializeChat({ ...row, internal: "secret" } as typeof row)).sort()).toEqual(
      ["createdAt", "id", "isPinned", "lastMessageAt", "title", "updatedAt", "userId"],
    );
  });

  it("round-trips unusual titles unchanged", () => {
    for (const title of ["日本語 \u{1F642}", "<script>alert(1)</script>", "  padded  ", "a".repeat(200)]) {
      expect(serializeChat({ ...row, title }).title).toBe(title);
    }
  });
});
