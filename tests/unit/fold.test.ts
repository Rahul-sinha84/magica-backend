import { describe, expect, it } from "vitest";
import {
  AgentStreamChunkSchema,
  ContentBlockSchema,
  blocksToText,
  foldChunks,
  type AgentStreamChunk,
} from "#src/contracts/index.js";

const text = (delta: string): AgentStreamChunk => ({ type: "text-delta", delta });
const thinking = (delta: string): AgentStreamChunk => ({ type: "thinking-delta", delta });
const start = (toolCallId: string, toolName = "crop_image"): AgentStreamChunk => ({
  type: "tool-start",
  toolCallId,
  toolName,
  toolInput: { id: toolCallId },
});
const end = (toolCallId: string, extra: Partial<Extract<AgentStreamChunk, { type: "tool-end" }>> = {}): AgentStreamChunk => ({
  type: "tool-end",
  toolCallId,
  status: "completed",
  ...extra,
});

describe("foldChunks", () => {
  it("returns no blocks for no chunks", () => {
    expect(foldChunks([])).toEqual([]);
  });

  it("joins consecutive deltas of the same kind into one block", () => {
    expect(foldChunks([text("Hel"), text("lo "), text("world")])).toEqual([{ type: "text", content: "Hello world" }]);
    expect(foldChunks([thinking("a"), thinking("b")])).toEqual([{ type: "thinking", content: "ab" }]);
  });

  it("keeps thinking before text as separate, ordered blocks", () => {
    expect(foldChunks([thinking("hm"), text("Hi"), thinking("again"), text("!")])).toEqual([
      { type: "thinking", content: "hm" },
      { type: "text", content: "Hi" },
      { type: "thinking", content: "again" },
      { type: "text", content: "!" },
    ]);
  });

  it("ignores empty deltas instead of creating empty blocks", () => {
    expect(foldChunks([text(""), thinking(""), text("a"), text("")])).toEqual([{ type: "text", content: "a" }]);
  });

  it("preserves whitespace, newlines and unicode inside deltas", () => {
    const folded = foldChunks([text("  line1\n"), text("\tline2 \u{1F600}\n\n")]);
    expect(folded).toEqual([{ type: "text", content: "  line1\n\tline2 \u{1F600}\n\n" }]);
  });

  describe("tools", () => {
    it("pairs a call with its result and records duration and cost", () => {
      const blocks = foldChunks([
        start("t1"),
        end("t1", { durationMs: 1700, creditCost: 70_000, result: { image_url: "https://x.test/a.png" } }),
      ]);
      expect(blocks).toEqual([
        { type: "tool_call", toolCallId: "t1", toolName: "crop_image", toolInput: { id: "t1" }, status: "completed", durationMs: 1700, creditCost: 70_000 },
        { type: "tool_result", toolCallId: "t1", toolName: "crop_image", result: { image_url: "https://x.test/a.png" }, isError: false },
      ]);
    });

    it("shows a call as running until it ends", () => {
      expect(foldChunks([start("t1")])).toEqual([expect.objectContaining({ type: "tool_call", status: "running" })]);
    });

    it("marks a failed tool and carries its error message", () => {
      const blocks = foldChunks([start("t1"), end("t1", { status: "failed", errorMessage: "Magica 429" })]);
      expect(blocks[0]).toMatchObject({ status: "failed" });
      expect(blocks[1]).toMatchObject({ isError: true, errorMessage: "Magica 429" });
    });

    it("keeps each result next to its call when tools and text interleave (parallel calls)", () => {
      const blocks = foldChunks([start("a"), start("b"), text("working"), end("b"), end("a"), text(" done")]);
      expect(blocks.map((b) => (b.type === "tool_call" || b.type === "tool_result" ? `${b.type}:${b.toolCallId}` : b.type))).toEqual([
        "tool_call:a",
        "tool_result:a",
        "tool_call:b",
        "tool_result:b",
        "text",
      ]);
      expect(blocksToText(blocks)).toBe("working done");
    });

    it("keeps appending to the open text block after a result is inserted above it", () => {
      const blocks = foldChunks([start("a"), text("x"), end("a"), text("y")]);
      expect(blocks.at(-1)).toEqual({ type: "text", content: "xy" });
    });

    it("omits the result key entirely when a tool returns nothing, and the block stays valid after a JSON round trip", () => {
      const blocks = foldChunks([start("t1"), end("t1", { status: "failed", errorMessage: "boom" })]);
      expect(blocks[1]).not.toHaveProperty("result");
      const stored = JSON.parse(JSON.stringify(blocks)) as unknown[]; // what JSONB gives back
      for (const block of stored) expect(ContentBlockSchema.safeParse(block).success).toBe(true);
    });

    it("ignores an end with no start, and a repeated start or end", () => {
      expect(foldChunks([end("ghost")])).toEqual([]);
      const once = foldChunks([start("t1"), end("t1")]);
      expect(foldChunks([start("t1"), start("t1"), end("t1"), end("t1", { status: "failed" })])).toEqual(once);
    });
  });

  it("appends generated assets in order", () => {
    const image = { type: "image" as const, url: "https://x.test/a.png", prompt: "sunset" };
    const video = { type: "video" as const, url: "https://x.test/a.mp4" };
    expect(foldChunks([text("Here:"), { type: "asset", asset: image }, { type: "asset", asset: video }])).toEqual([
      { type: "text", content: "Here:" },
      image,
      video,
    ]);
  });

  describe("purity and idempotency", () => {
    const stream: AgentStreamChunk[] = [
      thinking("plan"),
      start("a"),
      text("Hi "),
      end("a", { durationMs: 5, result: { ok: true } }),
      { type: "asset", asset: { type: "image", url: "https://x.test/a.png" } },
      text("there"),
    ];

    it("gives the same blocks every time it is run on the same array (replay never duplicates)", () => {
      expect(foldChunks(stream)).toEqual(foldChunks(stream));
      expect(foldChunks(structuredClone(stream))).toEqual(foldChunks(stream));
    });

    it("does not mutate its input", () => {
      const before = structuredClone(stream);
      foldChunks(stream);
      expect(stream).toEqual(before);
    });

    it("works on deeply frozen input, proving it never writes to the chunks", () => {
      const freeze = <T,>(value: T): T => {
        if (value && typeof value === "object") {
          Object.values(value).forEach(freeze);
          Object.freeze(value);
        }
        return value;
      };
      const frozen = freeze(structuredClone(stream));
      expect(foldChunks(frozen)).toEqual(foldChunks(stream));
    });

    it("does not alias asset chunks, so editing the output cannot change the stream", () => {
      const [block] = foldChunks([{ type: "asset", asset: { type: "image", url: "https://x.test/a.png" } }]);
      expect(block).toEqual({ type: "image", url: "https://x.test/a.png" });
      Object.assign(block as object, { url: "changed" });
      expect(foldChunks([{ type: "asset", asset: { type: "image", url: "https://x.test/a.png" } }])[0]).toMatchObject({ url: "https://x.test/a.png" });
    });

    it("folds a prefix of the stream into a prefix of the final text (what the polling fallback shows)", () => {
      const final = blocksToText(foldChunks(stream));
      for (let n = 0; n <= stream.length; n++) {
        expect(final.startsWith(blocksToText(foldChunks(stream.slice(0, n))))).toBe(true);
      }
    });

    it("produces only blocks the strict schema accepts", () => {
      for (const block of foldChunks(stream)) expect(ContentBlockSchema.safeParse(block).success).toBe(true);
    });

    it("handles a very long stream without slowing down", () => {
      const many = Array.from({ length: 50_000 }, () => text("x"));
      const started = performance.now();
      expect(blocksToText(foldChunks(many)).length).toBe(50_000);
      expect(performance.now() - started).toBeLessThan(1000);
    });
  });

  it("only ever receives chunks the contract allows", () => {
    // guards the test data above against drifting from the real chunk schema
    const sample = [text("a"), thinking("b"), start("c"), end("c")];
    for (const chunk of sample) expect(AgentStreamChunkSchema.safeParse(chunk).success).toBe(true);
  });
});

describe("blocksToText", () => {
  it("joins text blocks and skips thinking, tools and assets", () => {
    const blocks = foldChunks([thinking("secret"), text("A"), start("t"), end("t"), text("B")]);
    expect(blocksToText(blocks)).toBe("AB");
  });

  it("is empty when there is no text", () => {
    expect(blocksToText([])).toBe("");
    expect(blocksToText(foldChunks([thinking("only thinking")]))).toBe("");
  });
});
