import { CropImageInputSchema, GptImage2InputSchema, MergeVideosInputSchema, type V1ToolCall } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { AppError } from "#src/lib/errors.js";
import { toolTaskKey } from "#src/lib/idempotency.js";
import { logger } from "#src/lib/logger.js";
import { dispatchToolRun } from "#src/lib/trigger.js";
import type { StoredResponse } from "#src/services/idempotency.js";
import { QUEUE_LIMIT_MS, TOOL_CALL_LIMIT_MS } from "#src/services/reconcile.js";
import { createInvocation, endInvocation } from "#src/services/toolInvocations.js";
import { toolCallView } from "#src/services/v1Runs.js";
import { TOOL_CREDIT_COSTS } from "#src/tools/costs.js";

// Standalone tool runs (the public API's /v1/tools): one Magica tool, run directly. They go through the same steps as
// the agent's calls: the same input contract, credits reserved when recorded, the same durable magica-tool task, and
// charged exactly once on success (given back otherwise).

const INPUTS = { gpt_image_2: GptImage2InputSchema, crop_image: CropImageInputSchema, merge_videos: MergeVideosInputSchema } as const;
export type StandaloneTool = keyof typeof INPUTS;

const notFound = () => new AppError("NOT_FOUND", "That tool run isn't there.");

/** Checks the input, records the call (reserving its credits) and starts it. 402 when the credits aren't there. */
export async function startToolRun(userId: string, tool: StandaloneTool, rawInput: unknown, traceId: string): Promise<StoredResponse> {
  const input = INPUTS[tool].parse(rawInput);
  const invocation = await createInvocation({ userId, agentRunId: null, toolCallId: "api", toolName: tool, input, creditCost: TOOL_CREDIT_COSTS[tool] });
  try {
    await dispatchToolRun({ invocationId: invocation.id, userId, traceId }, toolTaskKey("api", invocation.id));
  } catch (err) {
    logger.error({ err, invocationId: invocation.id }, "could not start the standalone tool run");
    await endInvocation(invocation.id, "FAILED", "The tool couldn't be started, so nothing was charged. Please try again.");
    throw new AppError("SERVICE_UNAVAILABLE", "We couldn't start the tool. Please try again.");
  }
  logger.info({ invocationId: invocation.id, tool }, "standalone tool run started");
  return { status: 202, body: { runId: invocation.id, status: "queued" } };
}

/**
 * The user's tool run. One that should long be over is ended when read (credits given back), as the app does for
 * agent runs: never started within the queue's limit, or running past the tool's own time limit.
 */
export async function getToolRun(userId: string, runId: string, now = Date.now()): Promise<V1ToolCall> {
  const load = () => prisma.toolInvocation.findFirst({ where: { id: runId, userId }, include: { mediaAssets: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } });
  let call = await load();
  if (!call) throw notFound();
  const stuck =
    call.status === "PENDING"
      ? now - call.createdAt.getTime() >= QUEUE_LIMIT_MS && "The tool run couldn't start in time, so nothing was charged. Please try again."
      : (call.status === "DISPATCHING" || call.status === "RUNNING") &&
        now - (call.dispatchedAt ?? call.createdAt).getTime() >= TOOL_CALL_LIMIT_MS &&
        "The tool run took too long, so nothing was charged. Please try again.";
  if (stuck && (await endInvocation(call.id, "FAILED", stuck))) {
    logger.warn({ invocationId: call.id }, "ended a stuck standalone tool run");
    call = (await load()) ?? call;
  }
  return toolCallView(call);
}
