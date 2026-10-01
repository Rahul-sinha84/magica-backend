import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { assembleToolCalls, createStreamer, MAX_TOOL_ARGUMENTS_CHARS, ModelError, newToolCallId, type ChatMessage, type ModelEvent, type ModelTool } from "#src/lib/openrouter.js";
import { chunk, startModelServer, startSse, writeEvent, type ModelServer, type Step } from "../helpers/modelServer.js";

const servers: ModelServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function setup(steps: Step[]) {
  const server = await startModelServer(steps);
  servers.push(server);
  const stream = createStreamer({ baseURL: server.url, apiKey: "sk-or-test", sleep: () => Promise.resolve(), random: () => 0.5 });
  return { server, stream };
}
async function collect(events: AsyncGenerator<ModelEvent>): Promise<ModelEvent[]> {
  const all: ModelEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}
const calls = (events: ModelEvent[]) => events.filter((e) => e.type === "tool-call");
/** The calls without their (random) ids, after checking each id is one every provider accepts. */
const withoutIds = (events: ModelEvent[]) =>
  calls(events).map((call) => {
    expect(call.type === "tool-call" && call.id).toMatch(/^[A-Za-z0-9]{9}$/);
    const { id: _id, ...rest } = call;
    return rest;
  });

const TOOLS: ModelTool[] = [{ type: "function", function: { name: "crop_image", description: "Crop.", parameters: { type: "object", properties: { image_url: { type: "string" } } } } }];
const conversation: ChatMessage[] = [{ role: "user", content: "Crop it" }];

/** One streamed tool-call piece (index null leaves the index out, as some providers do). */
const piece = (index: number | null, part: { id?: string; name?: string; args?: string }) => ({
  ...chunk({}),
  choices: [{ index: 0, delta: { tool_calls: [{ ...(index !== null && { index }), ...(part.id !== undefined && { id: part.id, type: "function" }), function: { ...(part.name !== undefined && { name: part.name }), ...(part.args !== undefined && { arguments: part.args }) } }] }, finish_reason: null }],
});

/** A response made of text pieces, then tool-call pieces, then the end. */
const toolAnswer = (pieces: object[], text: string[] = []): Step => (_req, res: ServerResponse) => {
  startSse(res);
  writeEvent(res, chunk({ role: true, content: "" }));
  for (const t of text) writeEvent(res, chunk({ content: t }));
  for (const p of pieces) writeEvent(res, p);
  writeEvent(res, chunk({ content: "", finish: "tool_calls" }));
  writeEvent(res, chunk({ usage: { prompt_tokens: 30, completion_tokens: 12 } }));
  writeEvent(res, "[DONE]");
  res.end();
};

describe("offering tools", () => {
  it("sends the tools with tool_choice auto, and nothing when there are none", async () => {
    const { server, stream } = await setup([toolAnswer([piece(0, { id: "c1", name: "crop_image", args: "{}" })]), toolAnswer([], ["Hi"])]);
    await collect(stream(conversation, undefined, { tools: TOOLS }));
    expect(server.requests[0]?.body).toMatchObject({ tools: TOOLS, tool_choice: "auto" });
    await collect(stream(conversation));
    expect(server.requests[1]?.body).not.toHaveProperty("tools");
    expect(server.requests[1]?.body).not.toHaveProperty("tool_choice");
  });

  it("sends earlier tool calls and their results back exactly as given", async () => {
    const { server, stream } = await setup([toolAnswer([], ["Done."])]);
    const history: ChatMessage[] = [
      { role: "user", content: "Crop it" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "crop_image", arguments: '{"image_url":"https://a.test/1.png"}' } }] },
      { role: "tool", tool_call_id: "c1", content: '{"image":{"url":"https://a.test/2.png"}}' },
    ];
    await collect(stream(history, undefined, { tools: TOOLS }));
    expect(server.requests[0]?.body.messages).toEqual(history);
  });
});

describe("assembling streamed tool calls", () => {
  it("joins a call whose name and arguments arrive in many pieces, and parses its arguments", async () => {
    const { stream } = await setup([toolAnswer([piece(0, { id: "call_a", name: "crop_" }), piece(0, { name: "image", args: '{"image_' }), piece(0, { args: 'url": "https://a.test/1.png", ' }), piece(0, { args: '"crop": {"x": 0, "y": 0, "width": 100, "height": 50}}' })])]);
    const events = await collect(stream(conversation, undefined, { tools: TOOLS }));
    expect(withoutIds(events)).toEqual([
      {
        type: "tool-call",
        name: "crop_image",
        arguments: '{"image_url":"https://a.test/1.png","crop":{"x":0,"y":0,"width":100,"height":50}}',
        input: { image_url: "https://a.test/1.png", crop: { x: 0, y: 0, width: 100, height: 50 } },
      },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "tool_calls", inputTokens: 30, outputTokens: 12 });
  });

  it("keeps two interleaved calls apart and hands them on in index order", async () => {
    const { stream } = await setup([toolAnswer([piece(1, { id: "b", name: "merge_videos", args: '{"video_urls":' }), piece(0, { id: "a", name: "crop_image", args: '{"image_url":"https://a.test/1.png"}' }), piece(1, { args: '["https://a.test/1.mp4","https://a.test/2.mp4"]}' })])]);
    const events = await collect(stream(conversation, undefined, { tools: TOOLS }));
    expect(withoutIds(events).map((c) => [c.name, c.input])).toEqual([
      ["crop_image", { image_url: "https://a.test/1.png" }],
      ["merge_videos", { video_urls: ["https://a.test/1.mp4", "https://a.test/2.mp4"] }],
    ]);
  });

  it("hands on text first, then the calls, then the end", async () => {
    const { stream } = await setup([toolAnswer([piece(0, { id: "a", name: "crop_image", args: "{}" })], ["Let me ", "crop that."])]);
    expect((await collect(stream(conversation, undefined, { tools: TOOLS }))).map((e) => e.type)).toEqual(["text", "text", "tool-call", "done"]);
  });

  it("treats a reply with only tool calls (no text) as a real reply, not an empty one", async () => {
    const { server, stream } = await setup([toolAnswer([piece(0, { id: "a", name: "crop_image", args: "{}" })])]);
    expect(calls(await collect(stream(conversation, undefined, { tools: TOOLS })))).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
  });
});

describe("providers that stream tool calls differently", () => {
  it("doesn't double a name that is repeated in every piece", async () => {
    const { stream } = await setup([toolAnswer([piece(0, { id: "a", name: "crop_image", args: '{"image_url":' }), piece(0, { name: "crop_image", args: '"https://a.test/1.png"}' })])]);
    expect(calls(await collect(stream(conversation, undefined, { tools: TOOLS })))[0]).toMatchObject({ name: "crop_image", input: { image_url: "https://a.test/1.png" } });
  });

  it("tells calls apart by id when the index is left out", async () => {
    const { stream } = await setup([
      toolAnswer([
        piece(null, { id: "first", name: "crop_image", args: '{"image_url":' }),
        piece(null, { args: '"https://a.test/1.png"}' }),
        piece(null, { id: "second", name: "merge_videos", args: '{"video_urls":["https://a.test/1.mp4",' }),
        piece(null, { id: "second", args: '"https://a.test/2.mp4"]}' }),
      ]),
    ]);
    expect(withoutIds(await collect(stream(conversation, undefined, { tools: TOOLS }))).map((c) => [c.name, c.input])).toEqual([
      ["crop_image", { image_url: "https://a.test/1.png" }],
      ["merge_videos", { video_urls: ["https://a.test/1.mp4", "https://a.test/2.mp4"] }],
    ]);
  });
});

describe("tool calls that can't be used as they are", () => {
  it.each([
    ["invalid JSON", "{\"image_url\": ", "the arguments are not valid JSON"],
    ["a JSON array", "[1,2]", "the arguments must be a JSON object"],
    ["a JSON number", "5", "the arguments must be a JSON object"],
    ["JSON null", "null", "the arguments must be a JSON object"],
  ])("are marked malformed for %s, sent back with {} (valid for every provider), the raw text kept for logs", async (_label, args, reason) => {
    const { stream } = await setup([toolAnswer([piece(0, { id: "a", name: "crop_image", args })])]);
    expect(withoutIds(await collect(stream(conversation, undefined, { tools: TOOLS })))).toEqual([{ type: "tool-call", name: "crop_image", arguments: "{}", malformed: reason, rawArguments: args }]);
  });

  it("are marked malformed when the tool name is missing", async () => {
    const { stream } = await setup([toolAnswer([piece(0, { id: "a", args: "{}" })])]);
    expect(calls(await collect(stream(conversation, undefined, { tools: TOOLS })))[0]).toMatchObject({ name: "", arguments: "{}", malformed: "the tool call has no tool name" });
  });

  it("are marked malformed when the arguments are far too large, without keeping them", async () => {
    const huge = `{"prompt": "${"a".repeat(MAX_TOOL_ARGUMENTS_CHARS)}"}`;
    const { stream } = await setup([toolAnswer([piece(0, { id: "a", name: "crop_image", args: huge })])]);
    const [call] = calls(await collect(stream(conversation, undefined, { tools: TOOLS })));
    expect(call).toMatchObject({ arguments: "{}", malformed: expect.stringMatching(/too large/) as unknown });
    expect(call?.type === "tool-call" && call.rawArguments?.length).toBe(200);
  });
});

describe("tidying tool calls", () => {
  it("treats empty arguments as no arguments", async () => {
    const { stream } = await setup([toolAnswer([piece(0, { id: "a", name: "crop_image", args: "" })])]);
    expect(calls(await collect(stream(conversation, undefined, { tools: TOOLS })))[0]).toMatchObject({ input: {} });
  });

  it("gives every call its own id, whatever the model sent (missing, repeated, or one some providers reject)", async () => {
    const { stream } = await setup([toolAnswer([piece(0, { name: "crop_image", args: "{}" }), piece(1, { id: "call.1:x", name: "crop_image", args: "{}" }), piece(2, { id: "dup", name: "crop_image", args: "{}" }), piece(3, { id: "dup", name: "crop_image", args: "{}" })])]);
    const ids = calls(await collect(stream(conversation, undefined, { tools: TOOLS }))).map((c) => c.type === "tool-call" && c.id);
    expect(ids).toHaveLength(4);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(new Set(ids).size).toBe(4);
  });

  it("keeps calls in order across a gap in their indexes", async () => {
    const { stream } = await setup([toolAnswer([piece(2, { id: "c", name: "merge_videos", args: "{}" }), piece(0, { id: "a", name: "crop_image", args: "{}" })])]);
    expect(withoutIds(await collect(stream(conversation, undefined, { tools: TOOLS }))).map((c) => c.name)).toEqual(["crop_image", "merge_videos"]);
  });

  it("removes NUL characters from argument values (the database can't store them)", async () => {
    const { stream } = await setup([toolAnswer([piece(0, { id: "a", name: "crop_image", args: '{"image_url":"https://a.test/x\\u0000y.png","nested":{"k\\u0000":"v\\u0000"}}' })])]);
    expect(calls(await collect(stream(conversation, undefined, { tools: TOOLS })))[0]).toMatchObject({ input: { image_url: "https://a.test/xy.png", nested: { k: "v" } } });
  });
});

describe("failures while a tool call is streaming", () => {
  it("retries a stream that breaks off half-way through a call, since nothing has reached the user yet", async () => {
    const breaksOff: Step = (_req, res) => {
      startSse(res);
      writeEvent(res, piece(0, { id: "a", name: "crop_image", args: '{"image_url": "https:' }));
      setTimeout(() => res.destroy(), 50); // the piece reaches the client, then the connection dies
    };
    const { server, stream } = await setup([breaksOff, toolAnswer([piece(0, { id: "a", name: "crop_image", args: '{"image_url":"https://a.test/1.png"}' })])]);
    const events = await collect(stream(conversation, undefined, { tools: TOOLS }));
    expect(server.requests).toHaveLength(2);
    expect(withoutIds(events)).toEqual([expect.objectContaining({ name: "crop_image", input: { image_url: "https://a.test/1.png" } })]);
  });

  it("does not retry once text has reached the user, even if a tool call was coming", async () => {
    const textThenBreak: Step = (_req, res) => {
      startSse(res);
      writeEvent(res, chunk({ content: "Cropping now… " }));
      writeEvent(res, piece(0, { id: "a", name: "crop_image", args: '{"image' }));
      setTimeout(() => res.destroy(), 50); // let the text reach the client first
    };
    const { server, stream } = await setup([textThenBreak, toolAnswer([])]);
    const seen: ModelEvent[] = [];
    let error: unknown;
    try {
      for await (const event of stream(conversation, undefined, { tools: TOOLS })) seen.push(event);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).failure).toBe("INTERRUPTED");
    expect(calls(seen)).toEqual([]); // the half call is never handed on
    expect(server.requests).toHaveLength(1);
  });
});

describe("assembleToolCalls", () => {
  it("returns nothing for no pieces, and parses nested JSON", () => {
    expect(assembleToolCalls(new Map())).toEqual([]);
    expect(assembleToolCalls(new Map([[0, { id: "x", name: " crop_image ", arguments: '{"a":{"b":[1,2]}}' }]]), () => "abcdefghi")).toEqual([{ type: "tool-call", id: "abcdefghi", name: "crop_image", arguments: '{"a":{"b":[1,2]}}', input: { a: { b: [1, 2] } } }]);
  });

  it("sends back the cleaned arguments, so what the model sees is what ran", () => {
    const [call] = assembleToolCalls(new Map([[0, { id: "x", name: "crop_image", arguments: '{"image_url":"https://a.test/x\\u0000y.png"}' }]]), () => "abcdefghi");
    expect(call).toMatchObject({ input: { image_url: "https://a.test/xy.png" }, arguments: '{"image_url":"https://a.test/xy.png"}' });
    expect(() => JSON.parse(call?.arguments ?? "") as unknown).not.toThrow();
  });

  it("never gives two calls the same id, even if the id maker repeats itself", () => {
    const ids = ["same", "same", "same", "other"];
    const parts = new Map([[0, { id: "", name: "a", arguments: "" }], [1, { id: "", name: "b", arguments: "" }]]);
    expect(assembleToolCalls(parts, () => ids.shift() ?? "z").map((c) => c.id)).toEqual(["same", "other"]);
  });

  it("makes ids of 9 letters and digits", () => {
    for (let i = 0; i < 50; i++) expect(newToolCallId()).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(newToolCallId(() => 0)).toBe("aaaaaaaaa");
    expect(newToolCallId(() => 0.9999)).toBe("999999999");
  });
});
