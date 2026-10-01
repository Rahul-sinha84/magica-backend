import type { Logger } from "pino";
import type { AgentStreamChunk, AgentStreamMetadata } from "#src/contracts/index.js";
import type { MagicaToolPayload } from "#src/agent/payload.js";
import type { ChatMessage, ToolCallEvent } from "#src/lib/openrouter.js";
import { createInvocation, endInvocation, InsufficientCreditsForTool } from "#src/services/toolInvocations.js";
import type { InvocationOutcome } from "#src/tools/magicaInvocation.js";
import { displayInput, displayResult, sanitizeInput, type ToolDefinition, type ToolRegistry } from "#src/tools/registry.js";

// One step's tool calls: check each, run them (inline tools at once, Magica tools as one batch of durable child tasks),
// stream their progress, and turn their outcomes into the messages the model reads next. Results always go back in
// the order the model asked for them, whatever order they finished in.

export interface ToolStepDeps {
  registry: ToolRegistry;
  /** Runs Magica tool calls as durable child tasks, in parallel; resolves with each call's outcome, in the same order. */
  runMagicaCalls: (calls: MagicaToolPayload[]) => Promise<InvocationOutcome[]>;
  agentRunId: string;
  chatId: string;
  userId: string;
  traceId: string;
  log: Logger;
  signal: AbortSignal;
  /** Links that appear in the conversation; a tool may only use these (and grows as tools create media). */
  knownUrls: Set<string>;
  emit: (chunk: AgentStreamChunk) => void;
  setStatus: (status: AgentStreamMetadata) => void;
  now: () => number;
  /** Which step of the turn this is (tool calls are recorded under the step, as the model's ids repeat across steps). */
  step: number;
  /** Saves the reply so far; called once the tool cards have started, so a reload mid-tool shows them running. */
  checkpoint?: () => Promise<void>;
}

export interface ToolStepResult {
  /** The tool results, one per call, in call order, as the model reads them. */
  messages: ChatMessage[];
  /** A Magica call couldn't be paid for: the turn must stop after this step. */
  outOfCredits: boolean;
}

type Planned =
  | { kind: "error"; message: string }
  | { kind: "inline"; tool: ToolDefinition; input: unknown }
  | { kind: "magica"; tool: ToolDefinition; input: unknown };

type Outcome = { ok: true; output: unknown; durationMs: number; creditCost: number; tool: ToolDefinition; input: unknown } | { ok: false; message: string; durationMs?: number };

const OUT_OF_CREDITS = "You don't have enough credits for this.";

/** Every http(s) link in a text, without trailing punctuation. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'`]+/g)].map((m) => m[0].replace(/[.,;:!?)\]}]+$/, ""));
}

export async function runToolStep(calls: ToolCallEvent[], deps: ToolStepDeps): Promise<ToolStepResult> {
  const { registry, emit, setStatus, now, log } = deps;
  const keyOf = (call: ToolCallEvent) => `s${deps.step}-${call.id}`;

  // 1. Check every call before running any, and show each one starting.
  const plans: Planned[] = calls.map((call) => {
    const plan = planCall(call, registry, deps.knownUrls);
    const tool = plan.kind === "error" ? undefined : plan.tool;
    const shown = tool && plan.kind !== "error" ? displayInput(tool, plan.input) : (sanitizeInput(call.input ?? {}) as Record<string, unknown>);
    emit({ type: "tool-start", toolCallId: keyOf(call), toolName: call.name || "unknown", toolInput: shown });
    return plan;
  });
  const firstRunnable = plans.findIndex((plan) => plan.kind !== "error");
  if (firstRunnable >= 0) {
    const call = calls[firstRunnable];
    const plan = plans[firstRunnable];
    if (call && plan && plan.kind !== "error") setStatus({ status: "working", currentTool: { name: call.name, input: displayInput(plan.tool, plan.input), status: "running" } });
  }

  await deps.checkpoint?.();

  const outcomes: Outcome[] = plans.map((plan) => (plan.kind === "error" ? { ok: false, message: plan.message } : { ok: false, message: "Not run." }));

  // 2. Inline tools (the skill tools) run at once.
  const context = { agentRunId: deps.agentRunId, chatId: deps.chatId, userId: deps.userId, log, signal: deps.signal };
  await Promise.all(
    plans.map(async (plan, i) => {
      if (plan.kind !== "inline") return;
      const started = now();
      const result = await registry.execute(plan.tool.name, plan.input, context);
      outcomes[i] = result.ok ? { ok: true, output: result.output, durationMs: now() - started, creditCost: 0, tool: plan.tool, input: plan.input } : { ok: false, message: result.message, durationMs: now() - started };
    }),
  );

  // 3. Magica tools: record each and reserve its credits, then run them all as one batch of child tasks.
  let outOfCredits = false;
  const magicaIndexes = plans.flatMap((plan, i) => (plan.kind === "magica" ? [i] : []));
  const recorded: { index: number; invocationId: string }[] = [];
  for (const i of magicaIndexes) {
    const plan = plans[i];
    const call = calls[i];
    if (!plan || plan.kind !== "magica" || !call) continue;
    if (outOfCredits) {
      outcomes[i] = { ok: false, message: OUT_OF_CREDITS };
      continue;
    }
    try {
      const invocation = await createInvocation({ agentRunId: deps.agentRunId, userId: deps.userId, toolCallId: keyOf(call), toolName: plan.tool.name, input: plan.input, creditCost: plan.tool.creditCost });
      recorded.push({ index: i, invocationId: invocation.id });
    } catch (error) {
      if (!(error instanceof InsufficientCreditsForTool)) throw error;
      outOfCredits = true;
      outcomes[i] = { ok: false, message: OUT_OF_CREDITS };
    }
  }
  if (outOfCredits) {
    // the step can't be paid for in full: send none of it, and give back what was reserved for it
    for (const { index, invocationId } of recorded) {
      await endInvocation(invocationId, "CANCELLED", "Stopped: not enough credits.");
      outcomes[index] = { ok: false, message: "Stopped: not enough credits." };
    }
  } else if (recorded.length > 0) {
    const results = await deps.runMagicaCalls(recorded.map(({ invocationId }) => ({ invocationId, agentRunId: deps.agentRunId, chatId: deps.chatId, userId: deps.userId, traceId: deps.traceId })));
    recorded.forEach(({ index }, n) => {
      const plan = plans[index];
      const result = results[n];
      if (!plan || plan.kind !== "magica") return;
      outcomes[index] = result?.status === "COMPLETED"
        ? { ok: true, output: result.output, durationMs: result.durationMs, creditCost: plan.tool.creditCost, tool: plan.tool, input: plan.input }
        : { ok: false, message: result?.message ?? "The tool stopped unexpectedly." };
    });
  }

  // 4. Show each outcome, in order, and turn it into what the model reads next.
  const messages: ChatMessage[] = [];
  calls.forEach((call, i) => {
    const outcome = outcomes[i] ?? { ok: false, message: "Not run." };
    if (outcome.ok) {
      emit({ type: "tool-end", toolCallId: keyOf(call), status: "completed", durationMs: Math.max(0, Math.round(outcome.durationMs)), creditCost: outcome.creditCost, result: displayResult(outcome.tool, outcome.output) });
      for (const asset of outcome.tool.assets?.(outcome.output, outcome.input) ?? []) {
        emit({ type: "asset", asset });
        deps.knownUrls.add(asset.url); // later steps may use what this one made
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome.output) });
    } else {
      emit({ type: "tool-end", toolCallId: keyOf(call), status: "failed", errorMessage: outcome.message, ...(outcome.durationMs !== undefined && { durationMs: Math.max(0, Math.round(outcome.durationMs)) }) });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: outcome.message }) });
    }
  });
  // say explicitly that the tools are done (an update, delivered like any other), rather than only removing the field
  const lastRunnable = plans.map((plan, i) => ({ plan, i })).filter(({ plan }) => plan.kind !== "error").at(-1);
  const lastCall = lastRunnable ? calls[lastRunnable.i] : undefined;
  if (lastRunnable && lastCall && lastRunnable.plan.kind !== "error") {
    const outcome = outcomes[lastRunnable.i];
    setStatus({ status: "working", currentTool: { name: lastCall.name, input: displayInput(lastRunnable.plan.tool, lastRunnable.plan.input), status: outcome?.ok ? "completed" : "failed" } });
  } else {
    setStatus({ status: "working" });
  }
  return { messages, outOfCredits };
}

/** Whether a call can run, and how; or why not, in words the model can act on. */
function planCall(call: ToolCallEvent, registry: ToolRegistry, knownUrls: Set<string>): Planned {
  if (call.malformed) return { kind: "error", message: `Invalid tool call: ${call.malformed}.` };
  const parsed = registry.parseInput(call.name, call.input ?? {});
  if (!parsed.ok) return { kind: "error", message: parsed.message };
  const unknown = (parsed.tool.mediaUrls?.(parsed.input) ?? []).filter((url) => !knownUrls.has(url));
  if (unknown.length > 0) {
    return { kind: "error", message: `${unknown.length === 1 ? "This link doesn't" : "These links don't"} appear in the conversation: ${unknown.slice(0, 3).join(", ")}. Use the exact link from the conversation.` };
  }
  return { kind: parsed.tool.kind === "magica" ? "magica" : "inline", tool: parsed.tool, input: parsed.input };
}
