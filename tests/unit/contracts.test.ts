import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ActiveRunResponseSchema,
  AgentRunSchema,
  AgentStreamChunkSchema,
  AgentStreamMetadataSchema,
  ChatListResponseSchema,
  ChatSchema,
  ContentBlockSchema,
  ContentBlocksSchema,
  CreateChatBodySchema,
  CreditsResponseSchema,
  CursorQuerySchema,
  ErrorResponseSchema,
  IsoDateTimeSchema,
  MessageListResponseSchema,
  MessageSchema,
  RunStatusSchema,
  SendMessageBodySchema,
  SendMessageResponseSchema,
  UpdateChatBodySchema,
} from "#src/contracts/index.js";

const now = "2026-09-30T12:00:00.000Z";
const chat = { id: "c1", title: "Test", userId: "u1", isPinned: false, createdAt: now, updatedAt: now, lastMessageAt: now };
const message = { id: "m1", chatId: "c1", role: "USER", content: "hi", contentBlocks: [], status: "COMPLETED", createdAt: now };

describe("IsoDateTimeSchema", () => {
  it.each([now, "2026-09-30T17:30:00.000+05:30", "2026-09-30T12:00:00Z"])("accepts %s", (value) => {
    expect(IsoDateTimeSchema.safeParse(value).success).toBe(true);
  });

  it.each(["2026-09-30", "not a date", "", "2026-13-40T00:00:00Z"])("rejects %j", (value) => {
    expect(IsoDateTimeSchema.safeParse(value).success).toBe(false);
  });
});

describe("chats", () => {
  it("parses a chat and requires its id", () => {
    expect(ChatSchema.safeParse(chat).success).toBe(true);
    expect(ChatSchema.safeParse({ title: "No id" }).success).toBe(false);
  });

  it("requires isPinned and accepts a null lastMessageAt", () => {
    const { isPinned: _omit, ...withoutPin } = chat;
    expect(ChatSchema.safeParse(withoutPin).success).toBe(false);
    expect(ChatSchema.safeParse({ ...chat, lastMessageAt: null }).success).toBe(true);
  });

  it("lists chats with a cursor that may be null", () => {
    expect(ChatListResponseSchema.safeParse({ chats: [chat], cursor: null }).success).toBe(true);
    expect(ChatListResponseSchema.safeParse({ chats: [chat], cursor: "abc" }).success).toBe(true);
    expect(ChatListResponseSchema.safeParse({ chats: [chat] }).success).toBe(false);
  });

  describe("CreateChatBodySchema", () => {
    it("allows no title (the server picks one) and trims a given one", () => {
      expect(CreateChatBodySchema.parse({})).toEqual({});
      expect(CreateChatBodySchema.parse({ title: "  Plans  " })).toEqual({ title: "Plans" });
    });

    it.each([{ title: "" }, { title: "   " }, { title: "x".repeat(201) }, { title: 5 }, { title: "ok", extra: 1 }])(
      "rejects %j",
      (body) => {
        expect(CreateChatBodySchema.safeParse(body).success).toBe(false);
      },
    );

    it.each(["\u200b\u200b", "\u202e", "\u0301", "\ufe0f", " \u200b "])("rejects a title with no visible character %j", (title) => {
      expect(CreateChatBodySchema.safeParse({ title }).success).toBe(false);
      expect(UpdateChatBodySchema.safeParse({ title }).success).toBe(false);
    });

    it.each(["\u65e5\u672c\u8a9e", "\u{1F642}", "\u2026", "C++", "\u0661\u0662\u0663", "a\u200bb"])("accepts the title %j", (title) => {
      expect(CreateChatBodySchema.safeParse({ title }).success).toBe(true);
    });

    it("accepts exactly 200 characters", () => {
      expect(CreateChatBodySchema.safeParse({ title: "x".repeat(200) }).success).toBe(true);
    });
  });

  describe("UpdateChatBodySchema", () => {
    it.each([{ title: "New" }, { isPinned: true }, { title: "New", isPinned: false }])("accepts %j", (body) => {
      expect(UpdateChatBodySchema.safeParse(body).success).toBe(true);
    });

    it.each([{}, { isPinned: "yes" }, { title: "" }, { id: "hijack" }, { userId: "someone-else" }])("rejects %j", (body) => {
      expect(UpdateChatBodySchema.safeParse(body).success).toBe(false);
    });
  });
});

describe("CursorQuerySchema", () => {
  it("defaults the limit to 50 and coerces query-string numbers", () => {
    expect(CursorQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(CursorQuerySchema.parse({ limit: "25", cursor: "abc" })).toEqual({ limit: 25, cursor: "abc" });
  });

  it.each(["0", "101", "-1", "abc", "", "1.5", "NaN", "Infinity"])("rejects limit=%j", (limit) => {
    expect(CursorQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it("accepts the limit bounds", () => {
    expect(CursorQuerySchema.parse({ limit: "1" }).limit).toBe(1);
    expect(CursorQuerySchema.parse({ limit: "100" }).limit).toBe(100);
  });

  it("rejects a nested query parameter (qs turns limit[a]=1 into an object)", () => {
    expect(CursorQuerySchema.safeParse({ limit: { a: "1" } }).success).toBe(false);
    expect(CursorQuerySchema.safeParse({ cursor: { a: "1" } }).success).toBe(false);
  });

  it("rejects a repeated query parameter (Express delivers it as an array)", () => {
    expect(CursorQuerySchema.safeParse({ limit: ["1", "2"] }).success).toBe(false);
    expect(CursorQuerySchema.safeParse({ cursor: ["a", "b"] }).success).toBe(false);
  });

  it("rejects an empty or oversized cursor", () => {
    expect(CursorQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
    expect(CursorQuerySchema.safeParse({ cursor: "x".repeat(513) }).success).toBe(false);
  });
});

describe("SendMessageBodySchema", () => {
  const id = crypto.randomUUID();

  it("parses a minimal body and defaults attachments", () => {
    expect(SendMessageBodySchema.parse({ content: "Hello" })).toEqual({ content: "Hello", attachments: [] });
  });

  it("keeps the text exactly as typed, including indentation and trailing newlines", () => {
    const code = "  def f():\n      return 1\n\n";
    expect(SendMessageBodySchema.parse({ content: code }).content).toBe(code);
  });

  it.each(["", " ", "\n\t  \n", " ", "　"])("rejects blank content %j", (content) => {
    expect(SendMessageBodySchema.safeParse({ content }).success).toBe(false);
  });

  it("lower-cases clientMessageId so the same id in another case is the same key", () => {
    const id = crypto.randomUUID();
    const parsed = SendMessageBodySchema.parse({ content: "hi", clientMessageId: id.toUpperCase() });
    expect(parsed.clientMessageId).toBe(id);
  });

  it.each(["__proto__", "constructor", "prototype"])("rejects a %s key in the body (no prototype tricks)", (key) => {
    const body = JSON.parse(`{"content":"hi","${key}":{"isAdmin":true}}`) as unknown;
    expect(SendMessageBodySchema.safeParse(body).success).toBe(false);
  });

  it("gives every parse its own attachments array (a shared default would leak between requests)", () => {
    const first = SendMessageBodySchema.parse({ content: "a" });
    first.attachments.push("https://x.test/leak.png");
    expect(SendMessageBodySchema.parse({ content: "b" }).attachments).toEqual([]);
  });

  it("rejects NUL characters, which Postgres cannot store", () => {
    expect(SendMessageBodySchema.safeParse({ content: "a\u0000b" }).success).toBe(false);
    expect(CreateChatBodySchema.safeParse({ title: "a\u0000b" }).success).toBe(false);
    expect(UpdateChatBodySchema.safeParse({ title: "\u0000" }).success).toBe(false);
  });

  it("accepts emoji, RTL text and other control characters like tabs and newlines", () => {
    const text = "\u{1F600} \u05e9\u05dc\u05d5\u05dd\tline\nnext";
    expect(SendMessageBodySchema.parse({ content: text }).content).toBe(text);
  });

  it("enforces the 32000 character limit exactly", () => {
    expect(SendMessageBodySchema.safeParse({ content: "x".repeat(32_000) }).success).toBe(true);
    expect(SendMessageBodySchema.safeParse({ content: "x".repeat(32_001) }).success).toBe(false);
  });

  it("requires clientMessageId to be a UUID", () => {
    expect(SendMessageBodySchema.safeParse({ content: "hi", clientMessageId: id }).success).toBe(true);
    expect(SendMessageBodySchema.safeParse({ content: "hi", clientMessageId: "not-a-uuid" }).success).toBe(false);
    expect(SendMessageBodySchema.safeParse({ content: "hi", clientMessageId: null }).success).toBe(false);
  });

  it("limits attachments to 10 http(s) URLs", () => {
    const url = "https://cdn.example.com/a.png";
    expect(SendMessageBodySchema.safeParse({ content: "hi", attachments: Array(10).fill(url) }).success).toBe(true);
    expect(SendMessageBodySchema.safeParse({ content: "hi", attachments: Array(11).fill(url) }).success).toBe(false);
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "nope"]) {
      expect(SendMessageBodySchema.safeParse({ content: "hi", attachments: [bad] }).success).toBe(false);
    }
  });

  it("rejects unknown fields (no mass assignment)", () => {
    expect(SendMessageBodySchema.safeParse({ content: "hi", userId: "someone-else" }).success).toBe(false);
    expect(SendMessageBodySchema.safeParse({ content: "hi", role: "ASSISTANT" }).success).toBe(false);
  });

  it.each([null, undefined, "text", 5, []])("rejects a non-object body %j", (body) => {
    expect(SendMessageBodySchema.safeParse(body).success).toBe(false);
  });
});

describe("ContentBlockSchema", () => {
  const valid = [
    { type: "text", content: "Hi" },
    { type: "thinking", content: "hm", durationMs: 1200 },
    { type: "reasoning", content: "because" },
    { type: "image", url: "https://x.test/a.png", mimeType: "image/png" },
    { type: "video", url: "https://x.test/a.mp4", width: 1920, height: 1080 },
    { type: "tool_call", toolCallId: "t1", toolName: "gpt_image_2", toolInput: { prompt: "sunset" }, status: "running" },
    { type: "tool_result", toolCallId: "t1", toolName: "gpt_image_2", result: { ok: true } },
    { type: "citation", url: "https://example.com/doc", title: "Doc" },
    { type: "usage", inputTokens: 10, outputTokens: 20, model: "some/free-model" },
  ];

  it.each(valid)("parses a $type block", (block) => {
    expect(ContentBlockSchema.safeParse(block).success).toBe(true);
  });

  it("accepts a tool result that has no result value (JSONB drops undefined keys)", () => {
    expect(ContentBlockSchema.safeParse({ type: "tool_result", toolCallId: "a", toolName: "b" }).success).toBe(true);
  });

  it("defaults isError to false on a tool result", () => {
    expect(ContentBlockSchema.parse(valid[6])).toMatchObject({ isError: false });
  });

  it.each([
    { type: "unknown" },
    { type: "text" },
    { content: "no type" },
    { type: "tool_call", toolCallId: "t", toolName: "n", toolInput: [], status: "running" },
    { type: "tool_call", toolCallId: "t", toolName: "n", toolInput: {}, status: "exploded" },
    { type: "citation", url: "javascript:alert(1)" },
    { type: "citation", url: "data:text/html,<script>" },
  ])("rejects %j", (block) => {
    expect(ContentBlockSchema.safeParse(block).success).toBe(false);
  });
});

describe("ContentBlocksSchema (lenient reader)", () => {
  it("drops unreadable blocks and keeps the rest in order", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parsed = ContentBlocksSchema.parse([
      { type: "text", content: "a" },
      { type: "from-the-future", x: 1 },
      null,
      { type: "text", content: "b" },
    ]);
    expect(parsed).toEqual([
      { type: "text", content: "a" },
      { type: "text", content: "b" },
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("still rejects something that is not an array", () => {
    expect(ContentBlocksSchema.safeParse({ type: "text", content: "x" }).success).toBe(false);
  });
});

describe("messages", () => {
  it("parses a message", () => {
    expect(MessageSchema.safeParse(message).success).toBe(true);
    expect(MessageSchema.safeParse({ ...message, agentRunId: "r1", clientMessageId: crypto.randomUUID() }).success).toBe(true);
    expect(MessageSchema.safeParse({ ...message, agentRunId: null, clientMessageId: null }).success).toBe(true);
  });

  it.each(["BOT", "user", ""])("rejects role %j", (role) => {
    expect(MessageSchema.safeParse({ ...message, role }).success).toBe(false);
  });

  it("lists messages with a nullable cursor", () => {
    expect(MessageListResponseSchema.safeParse({ messages: [message], cursor: null }).success).toBe(true);
    expect(MessageListResponseSchema.safeParse({ messages: [message] }).success).toBe(false);
  });

  it("names both our run id and the Trigger run id in the send response", () => {
    const response = { message, chatId: "c1", runId: "r1", triggerRunId: "run_abc", realtimeToken: "tok", realtimeTokenExpiresAt: now };
    expect(SendMessageResponseSchema.safeParse(response).success).toBe(true);
    const { triggerRunId: _omit, ...withoutTrigger } = response;
    expect(SendMessageResponseSchema.safeParse(withoutTrigger).success).toBe(false);
  });
});

describe("runs", () => {
  it("maps Trigger's CANCELED to CANCELLED and accepts every status", () => {
    expect(RunStatusSchema.parse("CANCELED")).toBe("CANCELLED");
    for (const status of ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]) {
      expect(RunStatusSchema.parse(status)).toBe(status);
    }
    expect(RunStatusSchema.safeParse("CRASHED").success).toBe(false);
  });

  it("parses a run and an active-run snapshot (with partial output)", () => {
    const run = { id: "r1", chatId: "c1", triggerRunId: "run_abc", status: "RUNNING", startedAt: now, completedAt: null };
    expect(AgentRunSchema.safeParse(run).success).toBe(true);
    expect(
      ActiveRunResponseSchema.safeParse({
        run,
        realtimeToken: "tok",
        realtimeTokenExpiresAt: now,
        partialText: "Hel",
        partialBlocks: [{ type: "text", content: "Hel" }],
      }).success,
    ).toBe(true);
  });

  it("parses the empty active-run snapshot", () => {
    const parsed = ActiveRunResponseSchema.parse({
      run: null,
      realtimeToken: null,
      realtimeTokenExpiresAt: null,
      partialText: null,
      partialBlocks: [],
    });
    expect(parsed.run).toBeNull();
  });

  it("parses every metadata status", () => {
    for (const status of ["thinking", "streaming", "calling-tool", "complete", "failed", "cancelled", "stopping"]) {
      expect(AgentStreamMetadataSchema.safeParse({ status }).success).toBe(true);
    }
    expect(AgentStreamMetadataSchema.safeParse({ status: "working" }).success).toBe(false);
  });
});

describe("AgentStreamChunkSchema", () => {
  it.each([
    { type: "text-delta", delta: "Hi" },
    { type: "text-delta", delta: "" },
    { type: "thinking-delta", delta: "hm" },
    { type: "tool-start", toolCallId: "t1", toolName: "crop_image", toolInput: { x: 1 } },
    { type: "tool-end", toolCallId: "t1", status: "completed", durationMs: 12, creditCost: 5, result: { ok: 1 } },
    { type: "tool-end", toolCallId: "t1", status: "failed", errorMessage: "boom" },
    { type: "asset", asset: { type: "image", url: "https://x.test/a.png" } },
    { type: "asset", asset: { type: "video", url: "https://x.test/a.mp4" } },
  ])("parses %j", (chunk) => {
    expect(AgentStreamChunkSchema.safeParse(chunk).success).toBe(true);
  });

  it.each([
    { type: "text-delta" },
    { type: "tool-end", toolCallId: "t1", status: "pending" },
    { type: "asset", asset: { type: "text", content: "x" } },
    { type: "nope" },
    {},
  ])("rejects %j", (chunk) => {
    expect(AgentStreamChunkSchema.safeParse(chunk).success).toBe(false);
  });
});

describe("errors and credits", () => {
  it("keeps error as a plain string and adds a code", () => {
    expect(ErrorResponseSchema.safeParse({ error: "Not found", code: "NOT_FOUND" }).success).toBe(true);
    expect(ErrorResponseSchema.safeParse({ error: "x", code: "RUN_ACTIVE", details: { runId: "r1" } }).success).toBe(true);
    expect(ErrorResponseSchema.safeParse({ error: "Too big", code: "PAYLOAD_TOO_LARGE" }).success).toBe(true);
    expect(ErrorResponseSchema.safeParse({ error: { message: "nested" }, code: "NOT_FOUND" }).success).toBe(false);
    expect(ErrorResponseSchema.safeParse({ error: "x", code: "MADE_UP" }).success).toBe(false);
  });

  it("parses credits", () => {
    expect(CreditsResponseSchema.safeParse({ balance: 30_000_000, held: 0 }).success).toBe(true);
    expect(CreditsResponseSchema.safeParse({ balance: 1 }).success).toBe(false);
  });
});

describe("contract files stay portable", () => {
  const dir = "src/contracts";
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  it.each(files)("%s imports only zod and sibling contracts", (file) => {
    const specifiers = [...readFileSync(`${dir}/${file}`, "utf8").matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const specifier of specifiers) {
      expect(specifier === "zod" || /^\.\/[a-z]+\.js$/.test(specifier ?? "")).toBe(true);
    }
  });
});
