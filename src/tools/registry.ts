import type { Logger } from "pino";
import { z } from "zod";
import type { ContentBlock } from "#src/contracts/index.js";
import { ToolError, type ToolErrorCode } from "#src/tools/errors.js";

export { ToolError, type ToolErrorCode };

// One authoritative definition per tool. The model's tool list, input validation, execution, credit estimates and how
// a result is shown all come from here, so adding a tool means adding a definition, never editing the agent loop.

/** What a tool may know about the turn that called it. */
export interface ToolContext {
  agentRunId: string;
  chatId: string;
  userId: string;
  log: Logger;
  signal: AbortSignal;
}


/** Media blocks a tool's result adds to the reply (and to the artifact panel). */
export type AssetBlock = Extract<ContentBlock, { type: "image" | "video" | "audio" }>;

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  /** Shown to the model: when to use the tool. */
  description: string;
  input: z.ZodType<TInput, unknown>;
  output: z.ZodType<TOutput, unknown>;
  /** inline tools run inside the turn; magica tools run as durable child tasks */
  kind: "inline" | "magica";
  /** Credits one successful call costs. */
  creditCost: number;
  /** The media a result produced, in order. */
  assets?: (output: TOutput) => AssetBlock[];
  /** What is stored and shown of the input. Defaults to a generic clean-up (see sanitizeInput). */
  sanitize?: (input: TInput) => Record<string, unknown>;
  execute: (input: TInput, context: ToolContext) => Promise<TOutput>;
}

/**
 * Type-checks a definition as it is written (execute, assets and sanitize see the schema's exact types), then stores it
 * untyped so different tools can live in one list. That is safe because the registry only ever calls `execute` with
 * the output of the tool's own input schema, and checks what comes back with its output schema.
 */
export const defineTool = <TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): ToolDefinition => definition as unknown as ToolDefinition;

/** The OpenAI-format function a tool is offered to the model as. */
export interface FunctionTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type ToolResult = { ok: true; output: unknown; assets: AssetBlock[] } | { ok: false; code: ToolErrorCode; message: string };

const SECRET_KEY = /key|token|secret|password|authorization|cookie/i;
const MAX_TEXT = 500;
const MAX_ITEMS = 20;

/** A copy of a tool's input fit for storage and display: secrets dropped, long text and long lists shortened. */
export function sanitizeInput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => sanitizeInput(item, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `…and ${value.length - MAX_ITEMS} more`] : items;
  }
  if (value && typeof value === "object") {
    if (depth >= 4) return "…";
    return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEY.test(key)).map(([key, item]) => [key, sanitizeInput(item, depth + 1)]));
  }
  return value;
}

/** A readable, safe summary of why the model's input didn't fit (it is sent back so the model can correct itself). */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

export interface ToolRegistry {
  names(): string[];
  get(name: string): ToolDefinition | undefined;
  /** The tools array for the model request. */
  functions(): FunctionTool[];
  /** Validates the input with the tool's schema; the parsed value (defaults applied) or a safe error. */
  parseInput(name: string, raw: unknown): { ok: true; tool: ToolDefinition; input: unknown } | { ok: false; code: ToolErrorCode; message: string };
  /** Validates the input, runs the tool and validates what it returned. Never throws for a tool's own failure. */
  execute(name: string, raw: unknown, context: ToolContext): Promise<ToolResult>;
}

export function createToolRegistry(definitions: ToolDefinition[]): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  for (const tool of definitions) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
    if (tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    tools.set(tool.name, tool);
  }

  const functions: FunctionTool[] = [...tools.values()].map((tool) => {
    const { $schema: _schema, ...parameters } = z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" });
    return { type: "function", function: { name: tool.name, description: tool.description, parameters } };
  });

  const parseInput: ToolRegistry["parseInput"] = (name, raw) => {
    const tool = tools.get(name);
    if (!tool) return { ok: false, code: "UNKNOWN_TOOL", message: `Unknown tool: ${String(name).slice(0, 64)}` };
    const parsed = tool.input.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "INVALID_INPUT", message: `Invalid input for ${name}: ${describeIssues(parsed.error)}` };
    return { ok: true, tool, input: parsed.data };
  };

  return {
    names: () => [...tools.keys()],
    get: (name) => tools.get(name),
    functions: () => functions,
    parseInput,
    async execute(name, raw, context) {
      const parsed = parseInput(name, raw);
      if (!parsed.ok) return parsed;
      const { tool, input } = parsed;
      let output: unknown;
      try {
        output = await tool.execute(input, context);
      } catch (error) {
        // a tool's own safe errors are passed on; anything else is logged and replaced by a generic message
        if (error instanceof ToolError) return { ok: false, code: error.code, message: error.message };
        context.log.error({ err: error, tool: name }, "tool failed unexpectedly");
        return { ok: false, code: "TOOL_FAILED", message: `${name} failed. Please try again.` };
      }
      const checked = tool.output.safeParse(output);
      if (!checked.success) {
        context.log.error({ tool: name, issues: checked.error.issues.slice(0, 5) }, "tool returned an unexpected result");
        return { ok: false, code: "BAD_OUTPUT", message: `${name} returned an unexpected result.` };
      }
      return { ok: true, output: checked.data, assets: tool.assets?.(checked.data) ?? [] };
    },
  };
}

/** What a tool's input looks like when stored or shown. */
export const displayInput = (tool: ToolDefinition, input: unknown): Record<string, unknown> =>
  (tool.sanitize ? tool.sanitize(input) : sanitizeInput(input)) as Record<string, unknown>;
