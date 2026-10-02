import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CropImageInputSchema, GptImage2InputSchema, LoadSkillInputSchema, MergeVideosInputSchema, ReadSkillAssetInputSchema } from "#src/contracts/index.js";
import { TurnError } from "#src/agent/turnError.js";
import { agentTools } from "#src/tools/index.js";
import { createToolRegistry, defineTool, describeIssues, displayInput, sanitizeInput, ToolError, type ToolContext } from "#src/tools/registry.js";
import { TOOL_CREDIT_COSTS } from "#src/tools/costs.js";

function context() {
  const lines: Record<string, unknown>[] = [];
  const log = pino({ level: "debug" }, { write: (l: string) => void lines.push(JSON.parse(l) as Record<string, unknown>) });
  const ctx: ToolContext = { agentRunId: "run1", chatId: "chat1", userId: "user1", log, signal: new AbortController().signal };
  return { ctx, lines };
}

const echo = (execute = vi.fn((input: { text: string; times: number }) => Promise.resolve({ said: input.text.repeat(input.times) }))) =>
  defineTool({
    name: "echo",
    description: "Repeat some text.",
    input: z.object({ text: z.string().min(1), times: z.int().min(1).default(1) }),
    output: z.object({ said: z.string() }),
    kind: "inline",
    creditCost: 7,
    execute,
  });

describe("executing a tool", () => {
  it("validates the input, applies its defaults, runs the tool once and returns its checked output", async () => {
    const execute = vi.fn((input: { text: string; times: number }) => Promise.resolve({ said: input.text.repeat(input.times) }));
    const registry = createToolRegistry([echo(execute)]);
    const { ctx } = context();
    expect(await registry.execute("echo", { text: "hi" }, ctx)).toEqual({ ok: true, output: { said: "hi" }, assets: [] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ text: "hi", times: 1 }, ctx);
  });

  it("refuses an unknown tool without running anything", async () => {
    const registry = createToolRegistry([echo()]);
    expect(await registry.execute("delete_everything", {}, context().ctx)).toEqual({ ok: false, code: "UNKNOWN_TOOL", message: "Unknown tool: delete_everything" });
    expect(await registry.execute("x".repeat(300), {}, context().ctx)).toMatchObject({ code: "UNKNOWN_TOOL", message: `Unknown tool: ${"x".repeat(64)}` });
  });

  it("refuses invalid input with a readable reason the model can act on, without running the tool", async () => {
    const execute = vi.fn();
    const registry = createToolRegistry([echo(execute)]);
    const result = await registry.execute("echo", { text: "", times: 0 }, context().ctx);
    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(result.ok || result.message).toMatch(/^Invalid input for echo: text: .+; times: .+/);
    expect(await registry.execute("echo", "not an object", context().ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await registry.execute("echo", null, context().ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes on a tool's own safe error", async () => {
    const registry = createToolRegistry([echo(vi.fn().mockRejectedValue(new ToolError("TOOL_FAILED", "The image service is busy, please try again.")))]);
    expect(await registry.execute("echo", { text: "x" }, context().ctx)).toEqual({ ok: false, code: "TOOL_FAILED", message: "The image service is busy, please try again." });
  });

  it("lets an error that ends the turn (a waitpoint that expired or was stopped) through, for the turn to handle", async () => {
    const expired = new TurnError("WAITPOINT_EXPIRED", "This approval expired. Send a new message to continue.");
    const registry = createToolRegistry([echo(vi.fn().mockRejectedValue(expired))]);
    await expect(registry.execute("echo", { text: "x" }, context().ctx)).rejects.toBe(expired);
  });

  it("hides an unexpected error behind a generic message, and logs it", async () => {
    const registry = createToolRegistry([echo(vi.fn().mockRejectedValue(new Error("ECONNREFUSED 10.0.0.7:5432 password=hunter2")))]);
    const { ctx, lines } = context();
    const result = await registry.execute("echo", { text: "x" }, ctx);
    expect(result).toEqual({ ok: false, code: "TOOL_FAILED", message: "echo failed. Please try again." });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(lines.some((l) => l.msg === "tool failed unexpectedly" && l.tool === "echo")).toBe(true);
  });

  it("catches a tool that returns the wrong shape", async () => {
    const registry = createToolRegistry([echo(vi.fn().mockResolvedValue({ said: 42 }))]);
    const { ctx, lines } = context();
    expect(await registry.execute("echo", { text: "x" }, ctx)).toEqual({ ok: false, code: "BAD_OUTPUT", message: "echo returned an unexpected result." });
    expect(lines.some((l) => l.msg === "tool returned an unexpected result")).toBe(true);
  });

  it("returns the media a result produced", async () => {
    const tool = defineTool({
      name: "draw",
      description: "Draw.",
      input: z.object({}),
      output: z.object({ urls: z.array(z.string()) }),
      kind: "inline",
      creditCost: 0,
      assets: (output) => output.urls.map((url) => ({ type: "image" as const, url })),
      execute: () => Promise.resolve({ urls: ["https://a.test/1.png", "https://a.test/2.png"] }),
    });
    expect(await createToolRegistry([tool]).execute("draw", {}, context().ctx)).toMatchObject({ ok: true, assets: [{ type: "image", url: "https://a.test/1.png" }, { type: "image", url: "https://a.test/2.png" }] });
  });

  it("refuses an invalid or duplicate tool name when the registry is built", () => {
    expect(() => createToolRegistry([echo(), echo()])).toThrow("Duplicate tool: echo");
    expect(() => createToolRegistry([{ ...echo(), name: "Bad Name" }])).toThrow("Invalid tool name");
  });

  it("needs nothing but a definition to add a tool", async () => {
    const registry = createToolRegistry([echo(), { ...echo(), name: "echo_twice" }]);
    expect(registry.names()).toEqual(["echo", "echo_twice"]);
    expect(registry.functions().map((f) => f.function.name)).toEqual(["echo", "echo_twice"]);
    expect(await registry.execute("echo_twice", { text: "a" }, context().ctx)).toMatchObject({ ok: true });
  });
});

describe("the tools offered to the model", () => {
  it("are OpenAI function definitions generated from the input schemas", () => {
    const [fn] = createToolRegistry([echo()]).functions();
    expect(fn).toEqual({
      type: "function",
      function: {
        name: "echo",
        description: "Repeat some text.",
        parameters: expect.objectContaining({ type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 }, times: expect.objectContaining({ type: "integer", minimum: 1, default: 1 }) as unknown } }) as unknown,
      },
    });
    expect(fn?.function.parameters).not.toHaveProperty("$schema");
  });

  it("match each tool's Zod schema: the same fields, required fields and choices", () => {
    const schemas = { load_skill: LoadSkillInputSchema, read_skill_asset: ReadSkillAssetInputSchema, gpt_image_2: GptImage2InputSchema, crop_image: CropImageInputSchema, merge_videos: MergeVideosInputSchema };
    const registry = createToolRegistry(
      Object.entries(schemas).map(([name, input]) => defineTool({ name, description: name, input: input as z.ZodType, output: z.unknown(), kind: "inline", creditCost: 0, execute: () => Promise.resolve(null) })),
    );
    for (const fn of registry.functions()) {
      const schema = schemas[fn.function.name as keyof typeof schemas];
      const params = fn.function.parameters as { properties: Record<string, { enum?: string[] }>; required?: string[] };
      expect(Object.keys(params.properties).sort()).toEqual(Object.keys(schema.shape).sort());
      const required = Object.entries(schema.shape).filter(([, field]) => !(field as z.ZodType).safeParse(undefined).success).map(([key]) => key);
      expect((params.required ?? []).sort()).toEqual(required.sort());
    }
    const gpt = registry.functions().find((f) => f.function.name === "gpt_image_2")?.function.parameters as { properties: Record<string, { enum?: string[] }> };
    expect(gpt.properties.quality?.enum).toEqual(["low", "medium", "high"]);
    expect(gpt.properties.mode?.enum).toEqual(["text", "edit"]);
  });
});

describe("the agent's tools today", () => {
  it("are the two skill tools and the plan tool (inline, free) and the three Magica tools (durable, priced)", () => {
    expect(agentTools.names()).toEqual(["load_skill", "read_skill_asset", "gpt_image_2", "crop_image", "merge_videos", "propose_plan"]);
    for (const name of ["load_skill", "read_skill_asset", "propose_plan"]) expect(agentTools.get(name)).toMatchObject({ kind: "inline", creditCost: 0 });
    expect(agentTools.get("gpt_image_2")).toMatchObject({ kind: "magica", creditCost: 1_000_000 });
    expect(agentTools.get("crop_image")).toMatchObject({ kind: "magica", creditCost: 200_000 });
    expect(agentTools.get("merge_videos")).toMatchObject({ kind: "magica", creditCost: 500_000 });
    expect(TOOL_CREDIT_COSTS).toEqual({ load_skill: 0, read_skill_asset: 0, gpt_image_2: 1_000_000, crop_image: 200_000, merge_videos: 500_000, propose_plan: 0 });
  });

  it("each have a description the model can act on", () => {
    for (const fn of agentTools.functions()) expect(fn.function.description.length).toBeGreaterThan(30);
  });
});

describe("what is stored and shown of a tool's input", () => {
  it("drops secret-looking fields at any depth", () => {
    expect(sanitizeInput({ prompt: "fox", api_key: "k", nested: { authToken: "t", password: "p", Authorization: "a", keep: 1 } })).toEqual({ prompt: "fox", nested: { keep: 1 } });
  });

  it("shortens long text and long lists", () => {
    const out = sanitizeInput({ prompt: "a".repeat(600), urls: Array.from({ length: 25 }, (_, i) => `u${i}`) }) as { prompt: string; urls: string[] };
    expect(out.prompt).toHaveLength(501);
    expect(out.prompt.endsWith("…")).toBe(true);
    expect(out.urls).toHaveLength(21);
    expect(out.urls.at(-1)).toBe("…and 5 more");
  });

  it("stops at a reasonable depth and keeps plain values", () => {
    expect(sanitizeInput({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: "…" } } } });
    expect(sanitizeInput({ n: 1, ok: true, none: null })).toEqual({ n: 1, ok: true, none: null });
  });

  it("uses a tool's own sanitize when it has one", () => {
    const tool = { ...echo(), sanitize: () => ({ shown: "custom" }) };
    expect(displayInput(tool, { text: "x" })).toEqual({ shown: "custom" });
    expect(displayInput(echo(), { text: "x", secret: "s" })).toEqual({ text: "x" });
  });
});

describe("describeIssues", () => {
  it("joins at most five issues, each with its field", () => {
    const result = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string(), e: z.string(), f: z.string() }).safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) expect(describeIssues(result.error).split("; ")).toHaveLength(5);
  });
});
