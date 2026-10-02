import { WEBHOOK_EVENTS, WebhookEventSchema, type WebhookEventType } from "#src/contracts/index.js";
import type { Prisma } from "#src/db/client.js";
import { sanitizeInput } from "#src/tools/registry.js";

// The events a run or a tool call raises, recorded as deliveries in the same transaction as the change they report (an
// outbox): either the change and its events are saved together, or neither is. Recording the same event again does
// nothing (unique per subscription and event). Shared by the API and the worker.

type Tx = Prisma.TransactionClient;
type RunEvent = Extract<WebhookEventType, `agent.${string}`>;
type ToolEvent = Extract<WebhookEventType, `tool.${string}`>;

export const ALL_WEBHOOK_EVENTS: readonly WebhookEventType[] = WEBHOOK_EVENTS;

async function record(tx: Tx, subscriptions: { id: string; metadata: Prisma.JsonValue }[], eventId: string, type: WebhookEventType, event: { success: boolean; runId: string; data: Record<string, unknown>; error: string | null }): Promise<string[]> {
  if (subscriptions.length === 0) return [];
  const createdAt = new Date().toISOString();
  const rows = await tx.webhookDelivery.createManyAndReturn({
    data: subscriptions.map((subscription) => ({
      subscriptionId: subscription.id,
      eventId,
      type,
      payload: WebhookEventSchema.parse({ ...event, type, metadata: subscription.metadata ?? null, createdAt }) as Prisma.InputJsonValue,
    })),
    skipDuplicates: true,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** Records a run's lifecycle event for its subscriptions that asked for it; returns the new deliveries' ids. */
export async function recordRunEvent(tx: Tx, runId: string, type: RunEvent): Promise<string[]> {
  const subscriptions = await tx.webhookSubscription.findMany({ where: { agentRunId: runId, events: { has: type } }, select: { id: true, metadata: true } });
  if (subscriptions.length === 0) return [];
  const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
  const credits = (await tx.toolInvocation.aggregate({ where: { agentRunId: runId, status: "COMPLETED" }, _sum: { creditCost: true } }))._sum.creditCost ?? 0;
  const base = { chatId: run.chatId, messageId: run.triggerMessageId, replyId: run.assistantMessageId, status: run.status };
  const data =
    type === "agent.completed"
      ? { ...base, model: run.model, usage: { inputTokens: run.inputTokens ?? 0, outputTokens: run.outputTokens ?? 0, credits } }
      : type === "agent.failed"
        ? { ...base, code: run.errorCode }
        : base;
  const success = type === "agent.started" || type === "agent.completed";
  const error = type === "agent.failed" ? (run.errorMessage ?? "The run failed.") : null;
  return record(tx, subscriptions, type, type, { success, runId, data, error });
}

/**
 * Records a tool call's outcome for the subscriptions that cover it: its run's (an agent's call) or its own (a
 * standalone run). Only sanitized input is sent, and never Magica's run id or cost.
 */
export async function recordToolEvent(tx: Tx, invocationId: string, type: ToolEvent): Promise<string[]> {
  const call = await tx.toolInvocation.findUniqueOrThrow({ where: { id: invocationId }, include: { mediaAssets: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } });
  const subscriptions = await tx.webhookSubscription.findMany({
    where: { events: { has: type }, OR: [{ toolInvocationId: invocationId }, ...(call.agentRunId ? [{ agentRunId: call.agentRunId }] : [])] },
    select: { id: true, metadata: true },
  });
  const data = {
    toolCallId: call.id,
    tool: call.toolName,
    status: call.status,
    input: sanitizeInput(call.input),
    credits: call.creditCost,
    durationMs: call.durationMs,
    assets: call.mediaAssets.map((asset) => ({ type: asset.type.toLowerCase(), url: asset.url, mimeType: asset.mimeType, width: asset.width, height: asset.height })),
  };
  return record(tx, subscriptions, `${type}:${call.id}`, type, {
    success: type === "tool.completed",
    runId: call.agentRunId ?? call.id,
    data,
    error: type === "tool.failed" ? (call.errorMessage ?? "The tool failed.") : null,
  });
}
