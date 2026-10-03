import type { Logger } from "pino";
import { z } from "zod";
import { TurnError } from "#src/agent/turnError.js";
import type { ContentBlock, CreditPayload, PlanPayload } from "#src/contracts/index.js";
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
  /** Pauses the turn until the user answers (see src/waitpoints/wait.ts). Absent where the turn can't wait. */
  waitFor?: WaitFor;
}

/** The user's answer to a waitpoint. An expired or stopped one never returns: it ends the turn (a TurnError). */
export interface WaitAnswer {
  status: "approved" | "changes_requested" | "rejected";
  feedback?: string;
}

export interface WaitFor {
  (type: "plan", payload: PlanPayload): Promise<WaitAnswer>;
  (type: "credit", payload: CreditPayload): Promise<WaitAnswer>;
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
  /** The tool's typical cost in credits (0 for free tools): a plan's estimate, and what marks a tool as paid. */
  creditCost: number;
  /** What a call with this input will cost: the credits held while it runs (its real cost is charged after). Defaults to creditCost. */
  estimate?: (input: TInput) => number;
  /** The media a result produced, in order (the input supplies details such as the prompt, for the artifact panel). */
  assets?: (output: TOutput, input?: TInput) => AssetBlock[];
  /** What is stored and shown of the input. Defaults to a generic clean-up (see sanitizeInput). */
  sanitize?: (input: TInput) => Record<string, unknown>;
  /** The media links the input points at: each must already appear in the conversation (no invented or garbled links). */
  mediaUrls?: (input: TInput) => string[];
  /** What the tool card shows of a result (the model still gets the full result). Defaults to a shortened copy. */
  displayResult?: (output: TOutput) => unknown;
  /** inline tools: runs the tool inside the turn */
  execute?: (input: TInput, context: ToolContext) => Promise<TOutput>;
  /** magica tools: how the call maps onto a Magica model (it runs as a durable child task, see src/tools/magicaTools.ts) */
  magica?: MagicaSpec<TInput, TOutput>;
}

/** How a tool's input becomes a Magica run, and the run's output becomes the tool's output. */
export interface MagicaSpec<TInput, TOutput> {
  nodeType: string;
  /** the sub-model (mode) to run, when the model has several */
  subModelId?: (input: TInput) => string | undefined;
  /** names the work in messages: "Image generation", "Cropping", "Video merging" */
  label: string;
  /** the Magica input, before it is checked against the model's live schema */
  toInput: (input: TInput) => Record<string, unknown>;
  /** reads the run's output; throws a ToolError when it has no usable result */
  fromOutput: (output: unknown) => TOutput;
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
/** The credits to hold for a call with this (validated) input. */
export function estimateFor(tool: ToolDefinition, input: unknown): number {
  return tool.estimate ? tool.estimate(input) : tool.creditCost;
}

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
    if (tool.kind === "inline" ? !tool.execute : !tool.magica) throw new Error(`Tool ${tool.name} has no way to run for its kind (${tool.kind})`);
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
      // a media tool runs as a durable task with its own lifecycle and credits, never inline
      if (!tool.execute) return { ok: false, code: "TOOL_FAILED", message: `${name} runs as a background task and can't be run inline.` };
      let output: unknown;
      try {
        output = await tool.execute(input, context);
      } catch (error) {
        // a tool's own safe errors are passed on; anything else is logged and replaced by a generic message, except
        // what ends the whole turn (a waitpoint that expired or was stopped), which is the turn's to handle
        if (error instanceof TurnError) throw error;
        if (error instanceof ToolError) return { ok: false, code: error.code, message: error.message };
        context.log.error({ err: error, tool: name }, "tool failed unexpectedly");
        return { ok: false, code: "TOOL_FAILED", message: `${name} failed. Please try again.` };
      }
      const checked = tool.output.safeParse(output);
      if (!checked.success) {
        context.log.error({ tool: name, issues: checked.error.issues.slice(0, 5) }, "tool returned an unexpected result");
        return { ok: false, code: "BAD_OUTPUT", message: `${name} returned an unexpected result.` };
      }
      return { ok: true, output: checked.data, assets: tool.assets?.(checked.data, input) ?? [] };
    },
  };
}

/** What a tool card shows of a result. */
export const displayResult = (tool: ToolDefinition, output: unknown): unknown => (tool.displayResult ? tool.displayResult(output) : sanitizeInput(output));

/** What a tool's input looks like when stored or shown. */
export const displayInput = (tool: ToolDefinition, input: unknown): Record<string, unknown> =>
  (tool.sanitize ? tool.sanitize(input) : sanitizeInput(input)) as Record<string, unknown>;
