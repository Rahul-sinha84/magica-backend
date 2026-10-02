import { blocksToText, ContentBlocksSchema, V1RunSchema, type ContentBlock, type V1Run, type V1RunStatus } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import type { MediaAsset as MediaAssetRow } from "#src/generated/prisma/client.js";
import { AppError } from "#src/lib/errors.js";
import { cancelTriggerRun } from "#src/lib/trigger.js";
import { reconcileRun } from "#src/services/reconcile.js";
import { ACTIVE_STATUSES, finalizeRun } from "#src/services/runs.js";
import { sanitizeInput } from "#src/tools/registry.js";
import { serializeWaitpoint } from "#src/waitpoints/types.js";

// A run as the public API shows it: where it stands, what it cost, what it said and made so far, and what it is
// waiting for. It never shows Trigger.dev's or Magica's own ids, or what Magica charged us.

const notFound = () => new AppError("NOT_FOUND", "That run isn't there.");

const load = (userId: string, runId: string) =>
  prisma.agentRun.findFirst({
    where: { id: runId, userId },
    include: {
      assistantMessage: { select: { id: true, updatedAt: true, contentBlocks: true } },
      toolInvocations: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { mediaAssets: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } },
      waitpoints: { where: { status: "PENDING" }, take: 1 },
    },
  });

type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

const assetOf = (block: Extract<ContentBlock, { type: "image" | "video" | "audio" }>) => ({
  type: block.type,
  url: block.url,
  mimeType: block.mimeType ?? null,
  width: block.width ?? null,
  height: block.height ?? null,
});

const libraryAsset = (row: MediaAssetRow) => ({
  type: row.type === "IMAGE" ? ("image" as const) : row.type === "VIDEO" ? ("video" as const) : ("audio" as const),
  url: row.url,
  mimeType: row.mimeType,
  width: row.width,
  height: row.height,
});

function statusOf(run: Loaded): V1RunStatus {
  switch (run.status) {
    case "PENDING":
      return "queued";
    case "RUNNING":
      return run.waitpoints.length > 0 ? "waiting" : "running";
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
  }
}

function view(run: Loaded): V1Run {
  const blocks = ContentBlocksSchema.parse(Array.isArray(run.assistantMessage.contentBlocks) ? run.assistantMessage.contentBlocks : []);
  const pending = run.waitpoints[0];
  return V1RunSchema.parse({
    id: run.id,
    chatId: run.chatId,
    status: statusOf(run),
    mode: run.mode === "PLAN" ? "plan" : "default",
    model: run.model,
    usage: {
      inputTokens: run.inputTokens ?? 0,
      outputTokens: run.outputTokens ?? 0,
      credits: run.toolInvocations.reduce((sum, call) => sum + (call.status === "COMPLETED" ? (call.creditCost ?? 0) : 0), 0),
    },
    error: run.status === "FAILED" && run.errorCode ? { code: run.errorCode, message: run.errorMessage ?? "The run failed." } : null,
    reply: {
      messageId: run.assistantMessage.id,
      text: blocksToText(blocks),
      assets: blocks.flatMap((block) => (block.type === "image" || block.type === "video" || block.type === "audio" ? [assetOf(block)] : [])),
    },
    toolCalls: run.toolInvocations.map((call) => ({
      id: call.id,
      tool: call.toolName,
      status: call.status === "DISPATCHING" ? "running" : call.status.toLowerCase(),
      input: sanitizeInput(call.input) as Record<string, unknown>,
      credits: call.creditCost,
      durationMs: call.durationMs,
      assets: call.mediaAssets.map(libraryAsset),
      error: call.errorMessage,
      createdAt: call.createdAt.toISOString(),
      completedAt: call.completedAt?.toISOString() ?? null,
    })),
    pendingWaitpoint: pending ? serializeWaitpoint(pending) : null,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  });
}

/**
 * The user's run (anyone else's is not found). A run that looks active is checked first, as the app's own reads do,
 * so a client polling a run whose worker died sees it end instead of polling forever.
 */
export async function getV1Run(userId: string, runId: string): Promise<V1Run> {
  let run = await load(userId, runId);
  if (!run) throw notFound();
  if ((ACTIVE_STATUSES as readonly string[]).includes(run.status) && (await reconcileRun(run))) run = (await load(userId, runId)) ?? run;
  return view(run);
}

/** Stops the user's run if it is still going, and returns it as it stands (a finished run is returned unchanged). */
export async function cancelV1Run(userId: string, runId: string): Promise<V1Run> {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, userId }, select: { id: true, triggerRunId: true } });
  if (!run) throw notFound();
  if (await finalizeRun(run.id, { status: "CANCELLED" })) {
    if (run.triggerRunId) await cancelTriggerRun(run.triggerRunId); // stop the task too; the answer doesn't depend on it
  }
  const after = await load(userId, runId);
  if (!after) throw notFound(); // deleted with its chat a moment ago
  return view(after);
}
