import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentBlockSchema, type AgentStreamChunk, type AgentStreamMetadata } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { endAfterCancel, endAfterFailure } from "#src/agent/outcomes.js";
import type { AgentTurnPayload } from "#src/agent/payload.js";
import { runAgentTurn, type TurnDeps } from "#src/agent/runTurn.js";
import { ModelError } from "#src/lib/openrouter.js";
import { finalizeRun } from "#src/services/runs.js";
import { activeTurn, fixtures, resetDb } from "../helpers/db.js";
import { fakeModel, finished, reasoning, text, type Script } from "../helpers/fakeModel.js";

beforeEach(resetDb);
afterEach(() => void vi.restoreAllMocks());

async function setupTurn() {
  const user = await fixtures.user({ id: "u1", balance: 1_000_000 });
  const chat = await fixtures.chat(user.id);
  const turn = await activeTurn(chat.id, user.id, { status: "PENDING", triggerRunId: null, ageMs: 1_000 });
  const payload: AgentTurnPayload = { agentRunId: turn.run.id, chatId: chat.id, userId: user.id, assistantMessageId: turn.assistantMessage.id, traceId: "trace_test" };
  return { user, chat, turn, payload };
}

async function run(payload: AgentTurnPayload, script: Script, extra: Partial<TurnDeps> = {}) {
  const model = fakeModel(script);
  const emitted: AgentStreamChunk[] = [];
  const statuses: AgentStreamMetadata[] = [];
  const controller = new AbortController();
  const result = await runAgentTurn(payload, {
    stream: model.stream,
    emit: (chunk) => void emitted.push(chunk),
    setStatus: (status) => void statuses.push(status),
    triggerRunId: "run_trigger_1",
    signal: controller.signal,
    flushEveryMs: 0,
    ...extra,
  });
  return { result, model, emitted, statuses, controller };
}

const runRow = (id: string) => prisma.agentRun.findUniqueOrThrow({ where: { id } });
const reply = (id: string) => prisma.message.findUniqueOrThrow({ where: { id } });
const held = async () => (await prisma.user.findUniqueOrThrow({ where: { id: "u1" } })).held;
const releases = () => prisma.creditLedger.count({ where: { type: "RELEASE" } });

describe("a normal turn", () => {
  it("answers, ends the run, saves the reply, and returns the credits held for it", async () => {
    const { chat, turn, payload } = await setupTurn();
    const before = (await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } })).lastMessageAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const { result } = await run(payload, [text("Hello "), text("there"), finished("meta/free-7b", 12, 5)]);

    expect(result).toBe("completed");
    expect(await runRow(turn.run.id)).toMatchObject({ status: "COMPLETED", triggerRunId: "run_trigger_1", model: "meta/free-7b", inputTokens: 12, outputTokens: 5, errorCode: null });
    expect((await runRow(turn.run.id)).startedAt).toBeInstanceOf(Date);
    expect((await runRow(turn.run.id)).completedAt).toBeInstanceOf(Date);
    const saved = await reply(turn.assistantMessage.id);
    expect(saved).toMatchObject({ status: "COMPLETED", content: "Hello there" });
    expect(await held()).toBe(0);
    expect((await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } })).lastMessageAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("records which model really answered and what it used, at no credit cost, as the last block", async () => {
    const { turn, payload } = await setupTurn();
    await run(payload, [text("ok"), finished("meta/free-7b", 12, 5)]);
    const blocks = (await reply(turn.assistantMessage.id)).contentBlocks as unknown[];
    expect(blocks.at(-1)).toEqual({ type: "usage", inputTokens: 12, outputTokens: 5, model: "meta/free-7b", creditCost: 0 });
    for (const block of blocks) expect(ContentBlockSchema.safeParse(block).success).toBe(true);
  });

  it("falls back to the configured model name when the provider does not say which answered", async () => {
    const { turn, payload } = await setupTurn();
    await run(payload, [text("ok"), finished(null)]);
    expect(((await reply(turn.assistantMessage.id)).contentBlocks as { type: string; model?: string }[]).at(-1)).toMatchObject({ type: "usage", model: "openrouter/free" });
    expect((await runRow(turn.run.id)).model).toBe("openrouter/free");
  });

  it("keeps the thinking, with how long it took, ahead of the answer", async () => {
    const { turn, payload } = await setupTurn();
    let clock = 10_000;
    const { statuses } = await run(
      payload,
      [reasoning("hm, "), reasoning("let me see"), { then: () => void (clock += 2_500) }, text("The answer"), finished()],
      { now: () => clock },
    );
    const blocks = (await reply(turn.assistantMessage.id)).contentBlocks as { type: string; content?: string; durationMs?: number }[];
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "text", "usage"]);
    expect(blocks[0]).toMatchObject({ content: "hm, let me see", durationMs: 2_500 });
    expect(statuses).toContainEqual({ status: "working", thinkingDurationMs: 2_500 });
  });

  it("never stores thinking in the reply's plain text", async () => {
    const { turn, payload } = await setupTurn();
    await run(payload, [reasoning("secret reasoning"), text("Visible answer"), finished()]);
    expect((await reply(turn.assistantMessage.id)).content).toBe("Visible answer");
  });

  it("tells the live stream exactly what was written, in order, and reports progress as thinking, streaming, complete", async () => {
    const { payload } = await setupTurn();
    const { emitted, statuses } = await run(payload, [reasoning("a"), text("b"), text("c"), finished()]);
    expect(emitted).toEqual([
      { type: "thinking-delta", delta: "a" },
      { type: "text-delta", delta: "b" },
      { type: "text-delta", delta: "c" },
    ]);
    expect(statuses.map((s) => s.status)).toEqual(["thinking", "working", "complete"]);
  });

  it("treats an answer cut off by the length limit as a finished answer", async () => {
    const { turn, payload } = await setupTurn();
    const { result } = await run(payload, [text("cut off mid-sen"), finished("m", 1, 4096, "length")]);
    expect(result).toBe("completed");
    expect(await reply(turn.assistantMessage.id)).toMatchObject({ status: "COMPLETED", content: "cut off mid-sen" });
  });

  it("keeps text exactly as the model wrote it (whitespace, newlines, code)", async () => {
    const { turn, payload } = await setupTurn();
    const code = "  ```js\n  const x = 1;\n  ```\n\n  done 日本語\u{1F642}\n";
    await run(payload, [text(code.slice(0, 11)), text(code.slice(11)), finished()]);
    expect((await reply(turn.assistantMessage.id)).content).toBe(code);
  });
});

describe("what the model is shown", () => {
  it("is the system prompt, then the conversation ending with the question being answered", async () => {
    const { chat, turn, payload } = await setupTurn();
    const earlier = await prisma.message.createManyAndReturn({
      data: [
        { chatId: chat.id, userId: "u1", role: "USER", status: "COMPLETED", content: "First question", createdAt: new Date(Date.now() - 60_000) },
        { chatId: chat.id, userId: "u1", role: "ASSISTANT", status: "COMPLETED", content: "First answer", createdAt: new Date(Date.now() - 59_000) },
      ],
    });
    expect(earlier).toHaveLength(2);
    const { model } = await run(payload, [text("ok"), finished()], { now: () => Date.parse("2026-09-30T12:00:00Z") });
    const sent = model.calls[0]?.messages ?? [];
    expect(sent.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(sent[0]?.content).toContain("Magica");
    expect(sent[0]?.content).toContain("2026-09-30");
    expect(sent.slice(1).map((m) => m.content)).toEqual(["First question", "First answer", "hello"]);
    expect(turn.userMessage.content).toBe("hello");
  });

  it("leaves out failed and cancelled replies and the reply being written", async () => {
    const { chat, payload } = await setupTurn();
    await prisma.message.createMany({
      data: [
        { chatId: chat.id, userId: "u1", role: "USER", status: "COMPLETED", content: "Old question", createdAt: new Date(Date.now() - 60_000) },
        { chatId: chat.id, userId: "u1", role: "ASSISTANT", status: "FAILED", content: "Half an ans", createdAt: new Date(Date.now() - 59_000) },
        { chatId: chat.id, userId: "u1", role: "ASSISTANT", status: "CANCELLED", content: "Stopped early", createdAt: new Date(Date.now() - 58_000) },
      ],
    });
    const { model } = await run(payload, [text("ok"), finished()]);
    const contents = (model.calls[0]?.messages ?? []).slice(1).map((m) => m.content);
    expect(contents).toEqual(["Old question\n\nhello"]); // the two questions read as one speaker
    expect(contents.join(" ")).not.toMatch(/Half an ans|Stopped early/);
  });
});

describe("saving the reply as it is written", () => {
  it("saves what has been written so far, while the reply is still streaming", async () => {
    const { turn, payload } = await setupTurn();
    const seen: { status: string; content: string | null }[] = [];
    const peek = async () => {
      const row = await reply(turn.assistantMessage.id);
      seen.push({ status: row.status, content: row.content });
    };
    await run(payload, [text("Part one. "), { then: peek }, text("Part two."), { then: peek }, finished()]);
    expect(seen).toEqual([
      { status: "STREAMING", content: "Part one. " },
      { status: "STREAMING", content: "Part one. Part two." },
    ]);
  });

  it("does not save while text is arriving faster than the save interval", async () => {
    const { payload } = await setupTurn();
    const spy = vi.spyOn(prisma.message, "updateMany");
    await run(payload, [text("a"), text("b"), text("c"), text("d"), finished()], { now: () => 1_000, flushEveryMs: 1_000 });
    expect(spy.mock.calls.filter(([args]) => args.where?.status === "STREAMING")).toHaveLength(0); // the final write is the run's ending, not a save
  });

  it("saves once the interval has passed, and then waits a full interval again", async () => {
    const { payload } = await setupTurn();
    let clock = 1_000;
    const spy = vi.spyOn(prisma.message, "updateMany");
    await run(
      payload,
      [text("a"), { then: () => void (clock += 1_500) }, text("b"), text("c"), { then: () => void (clock += 200) }, text("d"), finished()],
      { now: () => clock, flushEveryMs: 1_000 },
    );
    expect(spy.mock.calls.filter(([args]) => args.where?.status === "STREAMING")).toHaveLength(1);
  });

  it("does not let a late save overwrite a reply that has already ended", async () => {
    const { turn, payload } = await setupTurn();
    const { result } = await run(payload, [
      text("Saved before the stop. "),
      { then: () => void 0 },
      text("Written after."),
      { then: () => finalizeRun(payload.agentRunId, { status: "CANCELLED" }).then(() => undefined) },
      text("Even later."),
      finished(),
    ]);
    expect(result).toBe("cancelled");
    const final = await reply(turn.assistantMessage.id);
    expect(final.status).toBe("CANCELLED");
    expect(final.content).toBe("Saved before the stop. Written after."); // what had been saved when it was stopped, nothing after
    expect(await releases()).toBe(1);
    expect(await held()).toBe(0);
  });

  it("reports cancelled when it finds the run was ended elsewhere", async () => {
    const { payload } = await setupTurn();
    const { statuses } = await run(payload, [
      text("a"),
      { then: () => finalizeRun(payload.agentRunId, { status: "CANCELLED" }).then(() => undefined) },
      text("b"),
      finished(),
    ]);
    expect(statuses.at(-1)).toEqual({ status: "cancelled" });
    expect(statuses.map((s) => s.status)).not.toContain("complete");
  });

  it("reports cancelled, not complete, when the run was ended just before the answer was saved", async () => {
    const { payload } = await setupTurn();
    const { result, statuses } = await run(payload, [text("All of it"), { then: () => finalizeRun(payload.agentRunId, { status: "CANCELLED" }).then(() => undefined) }, finished()], { flushEveryMs: 1_000_000 });
    expect(result).toBe("cancelled");
    expect(statuses.at(-1)).toEqual({ status: "cancelled" });
  });

  it("stops asking the model for more once the run has ended elsewhere", async () => {
    const { payload } = await setupTurn();
    let asked = 0;
    const more = Array.from({ length: 40 }, () => [text("x"), { then: () => void asked++ }]).flat();
    const { result, model } = await run(payload, [
      text("a"),
      { then: () => finalizeRun(payload.agentRunId, { status: "CANCELLED" }).then(() => undefined) },
      ...more,
      finished(),
    ]);
    expect(result).toBe("cancelled");
    expect(model.calls[0]?.signal.aborted).toBe(true);
    expect(asked).toBeLessThanOrEqual(1); // it noticed on the very next save and stopped
  });

  it("carries on when a save fails for a moment (a database blip must not abort the answer)", async () => {
    const { turn, payload } = await setupTurn();
    vi.spyOn(prisma.message, "updateMany").mockRejectedValueOnce(new Error("blip"));
    const { result } = await run(payload, [text("Still "), text("answered"), finished()]);
    expect(result).toBe("completed");
    expect((await reply(turn.assistantMessage.id)).content).toBe("Still answered");
  });

  it("is not stopped by a failing live stream or status update", async () => {
    const { turn, payload } = await setupTurn();
    const { result } = await run(payload, [text("Hi"), finished()], {
      emit: () => {
        throw new Error("stream closed");
      },
      setStatus: () => {
        throw new Error("metadata unavailable");
      },
    });
    expect(result).toBe("completed");
    expect((await reply(turn.assistantMessage.id)).content).toBe("Hi");
  });
});

describe("taking the run", () => {
  it("does nothing, and never calls the model, if the run is gone", async () => {
    const { chat, payload } = await setupTurn();
    await prisma.chat.delete({ where: { id: chat.id } });
    const { result, model } = await run(payload, [text("x"), finished()]);
    expect(result).toBe("skipped");
    expect(model.calls).toHaveLength(0);
  });

  it.each(["CANCELLED", "FAILED", "COMPLETED"] as const)("does nothing if the run already ended as %s", async (status) => {
    const { turn, payload } = await setupTurn();
    await finalizeRun(turn.run.id, { status, ...(status === "COMPLETED" && { blocks: [{ type: "text", content: "done" }] }) });
    const { result, model } = await run(payload, [text("x"), finished()]);
    expect(result).toBe("skipped");
    expect(model.calls).toHaveLength(0);
    expect(await runRow(turn.run.id)).toMatchObject({ status });
  });

  it("does nothing if another worker already took it", async () => {
    const { turn, payload } = await setupTurn();
    await prisma.agentRun.update({ where: { id: turn.run.id }, data: { status: "RUNNING" } });
    const { result, model } = await run(payload, [text("x"), finished()]);
    expect(result).toBe("skipped");
    expect(model.calls).toHaveLength(0);
  });

  it("answers once when the same run is delivered twice at the same time", async () => {
    const { turn, payload } = await setupTurn();
    const [a, b] = await Promise.all([run(payload, [text("one"), finished()]), run(payload, [text("two"), finished()])]);
    expect([a.result, b.result].sort()).toEqual(["completed", "skipped"]);
    expect(a.model.calls.length + b.model.calls.length).toBe(1);
    expect(await releases()).toBe(1);
    expect(["one", "two"]).toContain((await reply(turn.assistantMessage.id)).content);
  });

  it("records the Trigger.dev run id (the API's own save of it is best effort)", async () => {
    const { turn, payload } = await setupTurn();
    await run(payload, [text("ok"), finished()], { triggerRunId: "run_from_the_worker" });
    expect((await runRow(turn.run.id)).triggerRunId).toBe("run_from_the_worker");
  });

  it("fails clearly, without calling the model, if the question cannot be found", async () => {
    const { turn, payload } = await setupTurn();
    await prisma.agentRun.update({ where: { id: turn.run.id }, data: { triggerMessageId: turn.assistantMessage.id } }); // points at a reply, which is never a question
    await prisma.message.update({ where: { id: turn.assistantMessage.id }, data: { chatId: (await fixtures.chat("u1")).id } });
    const { result, model } = await run(payload, [text("x"), finished()]);
    expect(result).toBe("failed");
    expect(model.calls).toHaveLength(0);
    expect(await runRow(turn.run.id)).toMatchObject({ status: "FAILED", errorCode: "CONTEXT_EMPTY" });
  });
});

describe("when the model cannot answer", () => {
  it("fails the run with the model's reason in words safe to show, and returns the credits", async () => {
    const { turn, payload } = await setupTurn();
    const { result, statuses } = await run(payload, [{ fail: new ModelError("RATE_LIMITED", "429: too many requests from key sk-or-secret", true) }]);
    expect(result).toBe("failed");
    expect(await runRow(turn.run.id)).toMatchObject({
      status: "FAILED",
      errorCode: "MODEL_RATE_LIMITED",
      errorMessage: "The free model is busy right now. Please try again in a moment.",
    });
    expect(await reply(turn.assistantMessage.id)).toMatchObject({ status: "FAILED", content: null });
    expect(statuses.at(-1)).toEqual({ status: "failed", error: "The free model is busy right now. Please try again in a moment." });
    expect(await held()).toBe(0);
    expect(JSON.stringify(await runRow(turn.run.id))).not.toContain("sk-or-secret");
  });

  it("keeps the part of the answer that was already written when it breaks off part-way", async () => {
    const { turn, payload } = await setupTurn();
    const { result } = await run(payload, [reasoning("thinking first"), text("The first half of the answ"), { fail: new ModelError("INTERRUPTED", "connection dropped", false) }]);
    expect(result).toBe("failed");
    const saved = await reply(turn.assistantMessage.id);
    expect(saved).toMatchObject({ status: "FAILED", content: "The first half of the answ" });
    expect((saved.contentBlocks as { type: string }[]).map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(await runRow(turn.run.id)).toMatchObject({ errorCode: "MODEL_INTERRUPTED" });
  });

  it("fails as 'no answer' when the model only thought and never answered, keeping the thinking", async () => {
    const { turn, payload } = await setupTurn();
    const { result } = await run(payload, [reasoning("so much thinking"), finished()]);
    expect(result).toBe("failed");
    expect(await runRow(turn.run.id)).toMatchObject({ status: "FAILED", errorCode: "MODEL_EMPTY" });
    expect((await reply(turn.assistantMessage.id)).contentBlocks).toMatchObject([{ type: "thinking", content: "so much thinking" }]);
  });

  it("fails as 'no answer' when the model returns only whitespace", async () => {
    const { turn, payload } = await setupTurn();
    expect((await run(payload, [text("  \n "), finished()])).result).toBe("failed");
    expect(await runRow(turn.run.id)).toMatchObject({ errorCode: "MODEL_EMPTY" });
  });

  it("gives a generic, safe message for a bug, and never leaks what it was", async () => {
    const { turn, payload } = await setupTurn();
    const { result } = await run(payload, [{ fail: new TypeError("Cannot read properties of undefined (password=hunter2 at /srv/app/x.ts)") }]);
    expect(result).toBe("failed");
    const row = await runRow(turn.run.id);
    expect(row).toMatchObject({ errorCode: "AGENT_ERROR", errorMessage: "The agent ran into a problem. Please try again." });
    expect(JSON.stringify(row)).not.toMatch(/hunter2|srv\/app/);
  });

  it.each([
    ["RATE_LIMITED", "MODEL_RATE_LIMITED"],
    ["DAILY_LIMIT", "MODEL_DAILY_LIMIT"],
    ["UNAVAILABLE", "MODEL_UNAVAILABLE"],
    ["EMPTY", "MODEL_EMPTY"],
    ["REJECTED", "MODEL_REJECTED"],
    ["CONFIG", "MODEL_CONFIG"],
    ["INTERRUPTED", "MODEL_INTERRUPTED"],
  ] as const)("records the stable code for a %s failure", async (failure, code) => {
    const { turn, payload } = await setupTurn();
    await run(payload, [{ fail: new ModelError(failure, "detail", false) }]);
    expect((await runRow(turn.run.id)).errorCode).toBe(code);
  });

  it("tells the user when the free daily limit resets", async () => {
    const { turn, payload } = await setupTurn();
    await run(payload, [{ fail: new ModelError("DAILY_LIMIT", "429: Rate limit exceeded: free-models-per-day", false) }]);
    expect(await runRow(turn.run.id)).toMatchObject({ status: "FAILED", errorCode: "MODEL_DAILY_LIMIT", errorMessage: "The free model's daily limit is reached. It resets at 00:00 UTC." });
  });

  it("does not fail a turn that was already ended elsewhere (and does not release credits twice)", async () => {
    const { turn, payload } = await setupTurn();
    const { result } = await run(payload, [
      text("partial"),
      { then: () => finalizeRun(payload.agentRunId, { status: "CANCELLED" }).then(() => undefined) },
      { fail: new ModelError("UNAVAILABLE", "late failure", false) },
    ]);
    expect(["cancelled", "failed"]).toContain(result);
    expect(await runRow(turn.run.id)).toMatchObject({ status: "CANCELLED" });
    expect(await releases()).toBe(1);
  });
});

describe("being stopped from outside (a cancel, or running out of time)", () => {
  it("saves the partial reply when it is stopped, then the cancel hook ends the run exactly once", async () => {
    const { turn, payload } = await setupTurn();
    const controller = new AbortController();
    const model = fakeModel([text("Half of it. "), { then: () => void controller.abort() }, { wait: 10_000 }, finished()]);
    const result = await runAgentTurn(payload, { stream: model.stream, emit: () => undefined, setStatus: () => undefined, triggerRunId: "run_x", signal: controller.signal, flushEveryMs: 1_000_000 });
    expect(result).toBe("cancelled");
    expect(await reply(turn.assistantMessage.id)).toMatchObject({ status: "STREAMING", content: "Half of it. " }); // saved, not yet ended

    await endAfterCancel(payload.agentRunId);
    await endAfterCancel(payload.agentRunId); // hooks may be delivered twice
    expect(await reply(turn.assistantMessage.id)).toMatchObject({ status: "CANCELLED", content: "Half of it. " });
    expect(await runRow(turn.run.id)).toMatchObject({ status: "CANCELLED" });
    expect(await releases()).toBe(1);
    expect(await held()).toBe(0);
  });

  it("reports stopping as soon as it is told to stop, then cancelled once what was written is saved", async () => {
    const { turn, payload } = await setupTurn();
    const controller = new AbortController();
    const statuses: AgentStreamMetadata[] = [];
    const model = fakeModel([text("Half. "), { then: () => void controller.abort() }, { wait: 10_000 }, finished()]);
    await runAgentTurn(payload, { stream: model.stream, emit: () => undefined, setStatus: (s) => void statuses.push(s), triggerRunId: "run_x", signal: controller.signal, flushEveryMs: 1_000_000 });
    expect(statuses.map((s) => s.status)).toEqual(["thinking", "working", "stopping", "cancelled"]);
    expect((await reply(turn.assistantMessage.id)).content).toBe("Half. ");
  });

  it("does not start the model if it was already stopped when it began", async () => {
    const { turn, payload } = await setupTurn();
    const controller = new AbortController();
    controller.abort();
    const model = fakeModel([text("x"), finished()]);
    const result = await runAgentTurn(payload, { stream: model.stream, emit: () => undefined, setStatus: () => undefined, triggerRunId: "run_x", signal: controller.signal, flushEveryMs: 0 });
    expect(result).toBe("cancelled");
    expect((await reply(turn.assistantMessage.id)).content).toBeNull();
    await endAfterCancel(payload.agentRunId);
    expect(await runRow(turn.run.id)).toMatchObject({ status: "CANCELLED" });
  });
});

describe("the hooks that make sure a run ends", () => {
  it("end a run the turn could not end (the worker crashed), keeping the partial reply and returning the credits", async () => {
    const { turn, payload } = await setupTurn();
    await prisma.agentRun.update({ where: { id: turn.run.id }, data: { status: "RUNNING" } });
    await prisma.message.update({ where: { id: turn.assistantMessage.id }, data: { content: "Partial", contentBlocks: [{ type: "text", content: "Partial" }] } });
    await endAfterFailure(payload.agentRunId, new Error("worker process exited unexpectedly"));
    expect(await runRow(turn.run.id)).toMatchObject({ status: "FAILED", errorCode: "AGENT_ERROR" });
    expect(await reply(turn.assistantMessage.id)).toMatchObject({ status: "FAILED", content: "Partial" });
    expect(await held()).toBe(0);
  });

  it("call running out of time what it is", async () => {
    const { turn, payload } = await setupTurn();
    await endAfterFailure(payload.agentRunId, new Error("Run exceeded maxDuration of 600 seconds"));
    expect(await runRow(turn.run.id)).toMatchObject({ errorCode: "AGENT_TIMEOUT", errorMessage: "The agent took too long. Please try again." });
  });

  it("do nothing to a run that already ended", async () => {
    const { turn, payload } = await setupTurn();
    await run(payload, [text("Done"), finished()]);
    await endAfterFailure(payload.agentRunId, new Error("late"));
    await endAfterCancel(payload.agentRunId);
    expect(await runRow(turn.run.id)).toMatchObject({ status: "COMPLETED", errorCode: null });
    expect(await reply(turn.assistantMessage.id)).toMatchObject({ status: "COMPLETED", content: "Done" });
    expect(await releases()).toBe(1);
  });

  it("save the finished answer even if the database hiccups once at the very end", async () => {
    const { turn, payload } = await setupTurn();
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("database blip"));
    const { result } = await run(payload, [text("An answer that must not be lost"), finished()]);
    expect(result).toBe("completed");
    expect(await reply(turn.assistantMessage.id)).toMatchObject({ status: "COMPLETED", content: "An answer that must not be lost" });
    expect(await held()).toBe(0);
  });

  it("finish the job when the database stays unreachable through the whole turn's own attempts", async () => {
    const { turn, payload } = await setupTurn();
    vi.spyOn(prisma, "$transaction").mockRejectedValue(new Error("database unreachable"));
    await expect(run(payload, [text("An answer that cannot be saved"), finished()])).rejects.toThrow("database unreachable");
    vi.restoreAllMocks();
    expect(await runRow(turn.run.id)).toMatchObject({ status: "RUNNING" }); // not ended: the task fails, and its hook runs

    await endAfterFailure(payload.agentRunId, new Error("database unreachable"));
    expect(await runRow(turn.run.id)).toMatchObject({ status: "FAILED" });
    expect(await held()).toBe(0);
  });

  it("never expose what went wrong beyond a safe message", async () => {
    const { turn, payload } = await setupTurn();
    await endAfterFailure(payload.agentRunId, new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"));
    expect(JSON.stringify(await runRow(turn.run.id))).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
  });
});

describe("the failure reason reaches the client", () => {
  it("is returned on the failed reply in the message list, and only there", async () => {
    const { payload } = await setupTurn();
    await run(payload, [{ fail: new ModelError("UNAVAILABLE", "detail", false) }]);

    const { as } = await import("../helpers/app.js");
    const res = await as("u1").get(`/api/chats/${payload.chatId}/messages`);
    const messages = (res.body as { messages: { role: string; status: string; errorMessage?: string | null }[] }).messages;
    const failedReply = messages.find((m) => m.role === "ASSISTANT");
    expect(failedReply).toMatchObject({ status: "FAILED", errorMessage: "The assistant is unavailable right now. Please try again shortly." });
    expect(messages.find((m) => m.role === "USER")?.errorMessage ?? null).toBeNull();
  });

  it("is not shown for a reply that was cancelled or completed", async () => {
    const { payload } = await setupTurn();
    await run(payload, [text("Fine"), finished()]);
    const { as } = await import("../helpers/app.js");
    const res = await as("u1").get(`/api/chats/${payload.chatId}/messages`);
    for (const message of (res.body as { messages: { errorMessage?: string | null }[] }).messages) expect(message.errorMessage ?? null).toBeNull();
  });
});
