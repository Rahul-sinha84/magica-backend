import { afterEach, describe, expect, it } from "vitest";
import { FAILURE_INFO, ModelError, createStreamer, parseRetryAfter, type ChatMessage, type ModelEvent, type StreamerOptions } from "#src/lib/openrouter.js";
import {
  answer,
  chunk,
  emptyStream,
  neverAnswers,
  startModelServer,
  startSse,
  status,
  wait,
  writeEvent,
  type ModelServer,
  type Step,
} from "../helpers/modelServer.js";

const servers: ModelServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const conversation: ChatMessage[] = [
  { role: "system", content: "Be brief." },
  { role: "user", content: "Hello" },
];

/** A streamer against a fake server, with instant sleeping so retries are fast, and a record of how long it would have waited. */
async function setup(steps: Step[], options: StreamerOptions = {}) {
  const server = await startModelServer(steps);
  servers.push(server);
  const slept: number[] = [];
  const stream = createStreamer({
    baseURL: server.url,
    apiKey: "sk-or-test",
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5, // jitter factor of exactly 1
    ...options,
  });
  return { server, slept, stream };
}

async function collect(events: AsyncGenerator<ModelEvent>): Promise<ModelEvent[]> {
  const all: ModelEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}
const failure = async (events: AsyncGenerator<ModelEvent>) => {
  try {
    await collect(events);
  } catch (error) {
    return error;
  }
  return undefined;
};
const text = (events: ModelEvent[]) => events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
const thinking = (events: ModelEvent[]) => events.flatMap((e) => (e.type === "reasoning" ? [e.delta] : [])).join("");
const done = (events: ModelEvent[]) => events.find((e) => e.type === "done");

describe("a normal answer", () => {
  it("streams the text, then reports the model that answered and what it used", async () => {
    const { stream } = await setup([answer(["Hel", "lo ", "world"], { model: "meta/free-model-7b", tokens: [15, 4] })]);
    const events = await collect(stream(conversation));
    expect(text(events)).toBe("Hello world");
    expect(done(events)).toEqual({ type: "done", model: "meta/free-model-7b", inputTokens: 15, outputTokens: 4, finishReason: "stop" });
    expect(events.at(-1)?.type).toBe("done");
  });

  it("delivers the text in the pieces it arrived in", async () => {
    const { stream } = await setup([answer(["a", "b", "c"])]);
    expect((await collect(stream(conversation))).filter((e) => e.type === "text")).toEqual([
      { type: "text", delta: "a" },
      { type: "text", delta: "b" },
      { type: "text", delta: "c" },
    ]);
  });

  it("passes thinking through separately, before the answer, whichever field the model uses", async () => {
    const viaReasoning = await setup([answer(["Answer"], { reasoning: ["Let me ", "think"] })]);
    const first = await collect(viaReasoning.stream(conversation));
    expect(first.map((e) => e.type)).toEqual(["reasoning", "reasoning", "text", "done"]);
    expect(thinking(first)).toBe("Let me think");

    const viaContent = await setup([
      (_req, res) => {
        startSse(res);
        writeEvent(res, chunk({ reasoningContent: "hmm" }));
        writeEvent(res, chunk({ content: "ok", finish: "stop" }));
        writeEvent(res, "[DONE]");
        res.end();
      },
    ]);
    expect(thinking(await collect(viaContent.stream(conversation)))).toBe("hmm");
  });

  it("ignores empty and role-only pieces", async () => {
    const { stream } = await setup([
      (_req, res) => {
        startSse(res);
        writeEvent(res, chunk({ role: true, content: "" }));
        writeEvent(res, chunk({ content: "" }));
        writeEvent(res, chunk({ content: "hi", finish: "stop" }));
        writeEvent(res, "[DONE]");
        res.end();
      },
    ]);
    expect((await collect(stream(conversation))).map((e) => e.type)).toEqual(["text", "done"]);
  });

  it("reports zero usage and no model when the provider sends neither", async () => {
    const { stream } = await setup([
      (_req, res) => {
        startSse(res);
        writeEvent(res, { id: "x", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] });
        writeEvent(res, "[DONE]");
        res.end();
      },
    ]);
    expect(done(await collect(stream(conversation)))).toMatchObject({ model: null, inputTokens: 0, outputTokens: 0, finishReason: "stop" });
  });

  it("passes a 'length' finish through so the caller can tell the answer was cut short", async () => {
    const { stream } = await setup([answer(["cut off mid-sen"], { finish: "length" })]);
    expect(done(await collect(stream(conversation)))).toMatchObject({ finishReason: "length" });
  });

  it("handles a long answer made of thousands of pieces", async () => {
    const pieces = Array.from({ length: 3000 }, (_, i) => `w${i} `);
    const { stream } = await setup([answer(pieces)]);
    expect(text(await collect(stream(conversation)))).toBe(pieces.join(""));
  });
});

describe("what is asked of the model", () => {
  it("sends the conversation to the free router with a key, streaming, asking for usage, with a length cap", async () => {
    const { stream, server } = await setup([answer(["ok"])], { maxTokens: 1234 });
    await collect(stream(conversation));
    const [request] = server.requests;
    expect(request?.body).toMatchObject({
      model: "openrouter/free",
      messages: conversation,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 1234,
    });
    expect(request?.headers.authorization).toBe("Bearer sk-or-test");
  });

  it("never asks for any model other than the free router", async () => {
    const { stream, server } = await setup([answer(["ok"])]);
    await collect(stream(conversation));
    expect(server.requests.every((r) => r.body.model === "openrouter/free")).toBe(true);
  });

  it("makes exactly one request for a healthy answer (the SDK's own retrying is off)", async () => {
    const { stream, server } = await setup([answer(["ok"])]);
    await collect(stream(conversation));
    expect(server.requests).toHaveLength(1);
  });
});

describe("text that cannot be stored as it arrives", () => {
  it("drops NUL characters, which the database cannot hold", async () => {
    const { stream } = await setup([answer(["a\u0000b", "\u0000", "c"])]);
    expect(text(await collect(stream(conversation)))).toBe("abc");
  });

  it("keeps an emoji intact when the two halves arrive in different pieces", async () => {
    const emoji = "\u{1F642}";
    const { stream } = await setup([answer([`hi ${emoji.slice(0, 1)}`, `${emoji.slice(1)} there`])]);
    expect(text(await collect(stream(conversation)))).toBe(`hi ${emoji} there`);
  });

  it("does the same for thinking", async () => {
    const emoji = "\u{1F680}";
    const { stream } = await setup([answer(["ok"], { reasoning: [emoji.slice(0, 1), emoji.slice(1)] })]);
    expect(thinking(await collect(stream(conversation)))).toBe(emoji);
  });

  it("replaces a half emoji that never gets its other half, instead of losing it or breaking the database", async () => {
    const { stream } = await setup([answer(["end \ud83d"])]);
    expect(text(await collect(stream(conversation)))).toBe("end �");
  });

  it("replaces a stray low half in the middle of text", async () => {
    const { stream } = await setup([answer(["a\ude42b"])]);
    expect(text(await collect(stream(conversation)))).toBe("a�b");
  });

  it("never splits a long run of emoji that is cut at awkward places", async () => {
    const all = "\u{1F642}".repeat(40);
    const units = [...all].flatMap((c) => [c.slice(0, 1), c.slice(1)]); // every character cut in half
    const { stream } = await setup([answer(units)]);
    expect(text(await collect(stream(conversation)))).toBe(all);
  });
});

describe("retrying: only while nothing has reached the user", () => {
  it("tries again after a 429 and waits at least as long as the server asked", async () => {
    const { stream, server, slept } = await setup([status(429, { "retry-after": "2" }), answer(["fine"])]);
    const events = await collect(stream(conversation));
    expect(text(events)).toBe("fine");
    expect(server.requests).toHaveLength(2);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThanOrEqual(2000);
  });

  it("backs off with growing waits, and gives up after three tries with a rate-limit failure", async () => {
    const { stream, server, slept } = await setup([status(429)]);
    const error = await failure(stream(conversation));
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ failure: "RATE_LIMITED" });
    expect(server.requests).toHaveLength(3);
    expect(slept).toEqual([500, 1000]); // two waits between three tries
  });

  // the body OpenRouter really sends when the free route's per-account daily allowance is used up (captured 2026-10-01)
  const dailyLimitBody = {
    error: {
      message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
      code: 429,
      metadata: {
        headers: { "X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1790899200000" },
        limit_source: "openrouter_free_tier_daily",
        provider_name: null,
      },
    },
  };

  it("gives up at once on the free daily limit: no retries, its own failure", async () => {
    const { stream, server, slept } = await setup([status(429, { "x-ratelimit-reset": "1790899200000" }, dailyLimitBody), answer(["never reached"])]);
    const error = await failure(stream(conversation));
    expect(error).toMatchObject({ failure: "DAILY_LIMIT", retryable: false });
    expect(server.requests).toHaveLength(1);
    expect(slept).toEqual([]);
    expect(FAILURE_INFO.DAILY_LIMIT).toEqual({ code: "MODEL_DAILY_LIMIT", message: "The free model's daily limit is reached. It resets at 00:00 UTC." });
  });

  it("recognises the daily limit by its reason alone, and by its message alone", async () => {
    const bySource = { error: { message: "Rate limit exceeded", code: 429, metadata: { limit_source: "openrouter_free_tier_daily" } } };
    const byMessage = { error: { message: "Rate limit exceeded: free-models-per-day", code: 429 } };
    for (const body of [bySource, byMessage]) {
      const { stream, server } = await setup([status(429, {}, body), answer(["never reached"])]);
      expect(await failure(stream(conversation))).toMatchObject({ failure: "DAILY_LIMIT" });
      expect(server.requests).toHaveLength(1);
    }
  });

  it("still treats an ordinary 429 (another limit, or an odd body) as a busy model worth retrying", async () => {
    const otherLimit = { error: { message: "Rate limit exceeded: free-models-per-min", code: 429, metadata: { limit_source: "openrouter_free_tier_minute" } } };
    for (const body of [otherLimit, { error: "not an object" }, {}]) {
      const { stream, server } = await setup([status(429, {}, body), answer(["ok"])]);
      expect(text(await collect(stream(conversation)))).toBe("ok");
      expect(server.requests).toHaveLength(2);
    }
  });

  it("gives up at once on a daily limit reported inside the stream before any text", async () => {
    const { stream, server } = await setup([
      (_req, res) => {
        startSse(res);
        writeEvent(res, chunk({ error: { code: 429, message: "Rate limit exceeded: free-models-per-day" }, finish: "error" }));
        writeEvent(res, "[DONE]");
        res.end();
      },
      answer(["never reached"]),
    ]);
    expect(await failure(stream(conversation))).toMatchObject({ failure: "DAILY_LIMIT" });
    expect(server.requests).toHaveLength(1);
  });

  it("keeps what was written when a daily limit arrives after text (an interrupted answer, never retried)", async () => {
    const { stream, server } = await setup([
      (_req, res) => {
        startSse(res);
        writeEvent(res, chunk({ content: "partial " }));
        writeEvent(res, chunk({ error: { code: 429, message: "Rate limit exceeded: free-models-per-day" }, finish: "error" }));
        res.end();
      },
      answer(["never reached"]),
    ]);
    const events: ModelEvent[] = [];
    const error = await failure(
      (async function* () {
        for await (const event of stream(conversation)) {
          events.push(event);
          yield event;
        }
      })(),
    );
    expect(text(events)).toBe("partial ");
    expect(error).toMatchObject({ failure: "INTERRUPTED" });
    expect(server.requests).toHaveLength(1);
  });

  it.each([500, 502, 503, 504])("retries a %i and recovers", async (code) => {
    const { stream, server } = await setup([status(code), answer(["back"])]);
    expect(text(await collect(stream(conversation)))).toBe("back");
    expect(server.requests).toHaveLength(2);
  });

  it("reports unavailable after three server errors", async () => {
    const { stream, server } = await setup([status(503)]);
    expect(await failure(stream(conversation))).toMatchObject({ failure: "UNAVAILABLE" });
    expect(server.requests).toHaveLength(3);
  });

  it.each([
    [400, "REJECTED"],
    [404, "REJECTED"],
    [422, "REJECTED"],
    [401, "CONFIG"],
    [402, "CONFIG"],
    [403, "CONFIG"],
  ])("does not retry a %i (it would fail the same way): %s", async (code, expected) => {
    const { stream, server, slept } = await setup([status(code), answer(["never reached"])]);
    expect(await failure(stream(conversation))).toMatchObject({ failure: expected, retryable: false });
    expect(server.requests).toHaveLength(1);
    expect(slept).toHaveLength(0);
  });

  it("retries when nothing is listening, then reports unavailable", async () => {
    const server = await startModelServer([answer(["x"])]);
    const url = server.url;
    await server.close();
    const slept: number[] = [];
    const stream = createStreamer({ baseURL: url, apiKey: "k", sleep: (ms) => (slept.push(ms), Promise.resolve()), random: () => 0.5 });
    expect(await failure(stream(conversation))).toMatchObject({ failure: "UNAVAILABLE" });
    expect(slept).toHaveLength(2);
  });

  it("retries an answer that comes back empty, and accepts the next one", async () => {
    const { stream, server } = await setup([emptyStream, answer(["now there is text"])]);
    expect(text(await collect(stream(conversation)))).toBe("now there is text");
    expect(server.requests).toHaveLength(2);
  });

  it("fails with 'empty' if every try comes back empty", async () => {
    const { stream, server } = await setup([emptyStream]);
    expect(await failure(stream(conversation))).toMatchObject({ failure: "EMPTY" });
    expect(server.requests).toHaveLength(3);
  });

  it("retries a connection that is dropped before anything is sent", async () => {
    const { stream, server } = await setup([
      (req) => {
        req.socket.destroy();
      },
      answer(["recovered"]),
    ]);
    expect(text(await collect(stream(conversation)))).toBe("recovered");
    expect(server.requests).toHaveLength(2);
  });

  it("retries a provider error reported inside the stream before any text", async () => {
    const { stream, server } = await setup([
      (_req, res) => {
        startSse(res);
        writeEvent(res, chunk({ error: { code: 429, message: "provider busy" }, finish: "error" }));
        writeEvent(res, "[DONE]");
        res.end();
      },
      answer(["fine now"]),
    ]);
    expect(text(await collect(stream(conversation)))).toBe("fine now");
    expect(server.requests).toHaveLength(2);
  });

  it("retries a response it cannot parse, if nothing was sent yet", async () => {
    const { stream, server } = await setup([
      (_req, res) => {
        startSse(res);
        res.write("data: {this is not json\n\n");
        res.end();
      },
      answer(["parsed"]),
    ]);
    expect(text(await collect(stream(conversation)))).toBe("parsed");
    expect(server.requests).toHaveLength(2);
  });

  it("caps an enormous Retry-After so a bad header cannot stall the turn", async () => {
    const { stream, slept } = await setup([status(429, { "retry-after": "86400" }), answer(["ok"])], { maxDelayMs: 7_000 });
    await collect(stream(conversation));
    expect(slept[0]).toBeLessThanOrEqual(7_000);
  });

  it("uses the jitter so simultaneous retries do not line up", async () => {
    const low = await setup([status(429), answer(["ok"])], { random: () => 0 });
    await collect(low.stream(conversation));
    const high = await setup([status(429), answer(["ok"])], { random: () => 1 });
    await collect(high.stream(conversation));
    expect(low.slept[0]).toBe(250); // 500ms base, halved
    expect(high.slept[0]).toBe(750); // 500ms base, one and a half times
  });
});

describe("failing once the user has already seen part of the answer", () => {
  it("does not retry (it could not take back what was shown); reports an interruption", async () => {
    const { stream, server } = await setup([
      async (_req, res) => {
        startSse(res);
        writeEvent(res, chunk({ content: "Partway " }));
        await wait(10);
        writeEvent(res, chunk({ error: { code: 502, message: "provider died" }, finish: "error" }));
        res.end();
      },
      answer(["should never be asked for"]),
    ]);
    const seen: ModelEvent[] = [];
    let error: unknown;
    try {
      for await (const event of stream(conversation)) seen.push(event);
    } catch (caught) {
      error = caught;
    }
    expect(text(seen)).toBe("Partway ");
    expect(error).toMatchObject({ failure: "INTERRUPTED", retryable: false });
    expect(server.requests).toHaveLength(1);
  });

  it("reports an interruption when the connection drops part-way", async () => {
    const { stream, server } = await setup([
      async (req, res) => {
        startSse(res);
        writeEvent(res, chunk({ content: "Some of it" }));
        await wait(20);
        req.socket.destroy();
      },
      answer(["never"]),
    ]);
    const seen: ModelEvent[] = [];
    let error: unknown;
    try {
      for await (const event of stream(conversation)) seen.push(event);
    } catch (caught) {
      error = caught;
    }
    expect(text(seen)).toBe("Some of it");
    expect(error).toMatchObject({ failure: "INTERRUPTED" });
    expect(server.requests).toHaveLength(1);
  });
});

describe("a stream that goes quiet", () => {
  it("gives up on a server that never answers, and retries", async () => {
    const { stream, server } = await setup([neverAnswers, answer(["second try works"])], { stallMs: 120 });
    expect(text(await collect(stream(conversation)))).toBe("second try works");
    expect(server.requests).toHaveLength(2);
  });

  it("fails as unavailable if it never answers at all", async () => {
    const { stream } = await setup([neverAnswers], { stallMs: 80, attempts: 2 });
    expect(await failure(stream(conversation))).toMatchObject({ failure: "UNAVAILABLE" });
  });

  it("treats going quiet after some text as an interruption, keeping what arrived", async () => {
    const { stream } = await setup([
      (_req, res) => {
        startSse(res);
        writeEvent(res, chunk({ content: "Before the silence" }));
      },
    ], { stallMs: 100 });
    const seen: ModelEvent[] = [];
    let error: unknown;
    try {
      for await (const event of stream(conversation)) seen.push(event);
    } catch (caught) {
      error = caught;
    }
    expect(text(seen)).toBe("Before the silence");
    expect(error).toMatchObject({ failure: "INTERRUPTED" });
  });

  it("does not mistake a slow but steady stream for a stall", async () => {
    const { stream } = await setup([
      async (_req, res) => {
        startSse(res);
        for (const piece of ["a", "b", "c", "d"]) {
          writeEvent(res, chunk({ content: piece }));
          await wait(60);
        }
        writeEvent(res, chunk({ content: "", finish: "stop" }));
        writeEvent(res, "[DONE]");
        res.end();
      },
    ], { stallMs: 150 });
    expect(text(await collect(stream(conversation)))).toBe("abcd");
  });
});

describe("stopping", () => {
  it("stops promptly when told to, and closes the connection to the model", async () => {
    const { stream, server } = await setup([
      async (_req, res) => {
        startSse(res);
        for (let i = 0; i < 100; i++) {
          writeEvent(res, chunk({ content: `${i} ` }));
          await wait(20);
        }
      },
    ]);
    const controller = new AbortController();
    const seen: ModelEvent[] = [];
    let error: unknown;
    const started = Date.now();
    try {
      for await (const event of stream(conversation, controller.signal)) {
        seen.push(event);
        if (seen.length === 3) controller.abort();
      }
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(ModelError); // a stop is not a model failure
    expect(Date.now() - started).toBeLessThan(1_500);
    await wait(100);
    expect(server.closedEarly()).toBeGreaterThanOrEqual(1);
  });

  it("does not start at all if it is already stopped", async () => {
    const { stream, server } = await setup([answer(["x"])]);
    const controller = new AbortController();
    controller.abort();
    const error = await failure(stream(conversation, controller.signal));
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(ModelError);
    expect(server.requests.length).toBeLessThanOrEqual(1);
  });

  it("stops while waiting between retries", async () => {
    const server = await startModelServer([status(429)]);
    servers.push(server);
    const controller = new AbortController();
    const stream = createStreamer({ baseURL: server.url, apiKey: "k", baseDelayMs: 30_000, random: () => 0.5 });
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    const error = await failure(stream(conversation, controller.signal));
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(ModelError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("closes the connection if the caller simply stops reading", async () => {
    const { stream, server } = await setup([
      async (_req, res) => {
        startSse(res);
        for (let i = 0; i < 100; i++) {
          writeEvent(res, chunk({ content: `${i} ` }));
          await wait(20);
        }
      },
    ]);
    for await (const event of stream(conversation)) {
      if (event.type === "text") break;
    }
    await wait(150);
    expect(server.closedEarly()).toBeGreaterThanOrEqual(1);
  });
});

describe("parseRetryAfter", () => {
  const cap = 20_000;
  it.each([
    ["2", 2000],
    ["0", 0],
    ["1.5", 1500],
    ["30", cap],
  ])("reads %j as seconds (capped)", (value, expected) => {
    expect(parseRetryAfter(value, cap)).toBe(expected);
  });

  it("reads an HTTP date as the time until then", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    expect(parseRetryAfter("Wed, 30 Sep 2026 12:00:05 GMT", cap, now)).toBe(5000);
  });

  it.each([null, undefined, "", "soon", "-5", "Wed, 30 Sep 2020 12:00:05 GMT"])("ignores %j", (value) => {
    expect(parseRetryAfter(value, cap)).toBeUndefined();
  });
});

describe("what users are told", () => {
  it("has a safe message and a stable code for every failure, never mentioning providers, keys or status codes", () => {
    for (const info of Object.values(FAILURE_INFO)) {
      expect(info.message).not.toMatch(/openrouter|provider|api key|\b[45]\d\d\b|token/i);
      expect(info.code).toMatch(/^MODEL_[A-Z_]+$/);
    }
    expect(new Set(Object.values(FAILURE_INFO).map((i) => i.code)).size).toBe(Object.keys(FAILURE_INFO).length);
  });

  it("keeps the technical detail on the error for the logs, separate from the user's message", async () => {
    const { stream } = await setup([status(401)]);
    const error = (await failure(stream(conversation))) as ModelError;
    expect(error.message).toMatch(/401/);
    expect(FAILURE_INFO[error.failure].message).not.toMatch(/401/);
  });
});
