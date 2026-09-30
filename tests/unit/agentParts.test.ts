import { describe, expect, it } from "vitest";
import { ChunkQueue } from "#src/agent/chunkQueue.js";
import { describeFailure, TurnError } from "#src/agent/outcomes.js";
import { systemPrompt, withSystemPrompt } from "#src/agent/prompt.js";
import { FAILURE_INFO, ModelError, type ModelFailure } from "#src/lib/openrouter.js";

async function drain<T>(queue: ChunkQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of queue) out.push(item);
  return out;
}

describe("ChunkQueue", () => {
  it("delivers what was pushed before reading, in order", async () => {
    const q = new ChunkQueue<number>();
    q.push(1);
    q.push(2);
    q.end();
    expect(await drain(q)).toEqual([1, 2]);
  });

  it("delivers what is pushed while the reader is waiting", async () => {
    const q = new ChunkQueue<string>();
    const reading = drain(q);
    await new Promise((r) => setTimeout(r, 5));
    q.push("a");
    await new Promise((r) => setTimeout(r, 5));
    q.push("b");
    q.end();
    expect(await reading).toEqual(["a", "b"]);
  });

  it("finishes a waiting reader when it ends with nothing queued", async () => {
    const q = new ChunkQueue<number>();
    const reading = drain(q);
    q.end();
    expect(await reading).toEqual([]);
  });

  it("ignores pushes after the end, and ending twice is harmless", async () => {
    const q = new ChunkQueue<number>();
    q.push(1);
    q.end();
    q.end();
    q.push(2);
    expect(await drain(q)).toEqual([1]);
  });

  it("keeps falsy items such as 0 and empty strings", async () => {
    const q = new ChunkQueue<number | string>();
    q.push(0);
    q.push("");
    q.end();
    expect(await drain(q)).toEqual([0, ""]);
  });

  it("never makes the pusher wait, however much is queued", async () => {
    const q = new ChunkQueue<number>();
    for (let i = 0; i < 50_000; i++) q.push(i);
    q.end();
    expect((await drain(q)).length).toBe(50_000);
  });
});

describe("describeFailure", () => {
  it.each(Object.keys(FAILURE_INFO) as ModelFailure[])("explains a model failure (%s) with its fixed, safe text", (failure) => {
    expect(describeFailure(new ModelError(failure, "secret provider detail sk-or-123", false))).toEqual(FAILURE_INFO[failure]);
  });

  it("uses a turn error's own code and message", () => {
    expect(describeFailure(new TurnError("CONTEXT_EMPTY", "Please send it again."))).toEqual({ code: "CONTEXT_EMPTY", message: "Please send it again." });
  });

  it.each(["Task exceeded maxDuration of 600 seconds", "request timed out", "Run hit the time limit"])("recognises a time-out (%s)", (message) => {
    expect(describeFailure(new Error(message)).code).toBe("AGENT_TIMEOUT");
  });

  it.each([new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"), "a string", null, undefined, { any: "thing" }])("never reveals anything else (%j)", (error) => {
    expect(describeFailure(error)).toEqual({ code: "AGENT_ERROR", message: "The agent ran into a problem. Please try again." });
  });

  it("never puts provider detail into any safe message", () => {
    for (const info of Object.values(FAILURE_INFO)) expect(info.message).not.toMatch(/sk-|http|openrouter|\d{3}/i);
  });
});

describe("the system prompt", () => {
  it("states the date in UTC and that only text is possible", () => {
    const prompt = systemPrompt(new Date("2026-03-05T23:59:59-08:00"));
    expect(prompt).toContain("Today's date is 2026-03-06.");
    expect(prompt).toMatch(/only write text/);
  });

  it("goes first, before the conversation, without changing it", () => {
    const history = [{ role: "user" as const, content: "hi" }];
    const out = withSystemPrompt(history, new Date(0));
    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe("system");
    expect(out[1]).toEqual({ role: "user", content: "hi" });
    expect(history).toHaveLength(1);
  });
});
