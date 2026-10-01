import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { currentUserId } from "#src/auth/middleware.js";
import { ActiveRunResponseSchema, ContentBlocksSchema, RetryRunResponseSchema, blocksToText } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { AppError } from "#src/lib/errors.js";
import { addLogContext, logContext, logger } from "#src/lib/logger.js";
import { IdSchema } from "#src/lib/cursor.js";
import { cancelTriggerRun } from "#src/lib/trigger.js";
import { parseChatId, requireChat } from "#src/services/chats.js";
import { reconcileRun } from "#src/services/reconcile.js";
import { ACTIVE_STATUSES, finalizeRun, findActiveRun } from "#src/services/runs.js";
import { realtimeAccess, retryRun } from "#src/services/turns.js";

const noActiveRun = () => new AppError("NOT_FOUND", "That run isn't active.");

/** Mounted at /api. A retry starts a turn, so it shares the send limiter: retrying can't get around it. */
export function runsRouter(sendLimit: RequestHandler): Router {
  const router = Router();

  // What the client asks on load and while it waits: is a run going for this chat, and what has it written so far?
  // Only a run in flight is returned; `run: null` means it is over (or there never was one), and the client then fetches
  // the finished messages.
  router.get("/chats/:chatId/active-run", async (req, res) => {
    const chatId = parseChatId(req.params.chatId);
    await requireChat(currentUserId(res), chatId);

    let run = await findActiveRun(chatId);
    if (run && (await reconcileRun(run))) run = null; // a run that is really dead must not look alive

    if (!run) {
      res.json(ActiveRunResponseSchema.parse({ run: null, realtimeToken: null, realtimeTokenExpiresAt: null, partialText: null, partialBlocks: [] }));
      return;
    }

    const partialBlocks = ContentBlocksSchema.parse(Array.isArray(run.assistantMessage.contentBlocks) ? run.assistantMessage.contentBlocks : []);
    const access = run.triggerRunId ? await realtimeAccess(run.triggerRunId) : null;
    res.json(
      ActiveRunResponseSchema.parse({
        run: {
          id: run.id,
          chatId: run.chatId,
          triggerRunId: run.triggerRunId,
          status: run.status,
          startedAt: run.startedAt?.toISOString() ?? null,
          completedAt: null,
        },
        realtimeToken: access?.token || null,
        realtimeTokenExpiresAt: access?.token ? access.expiresAt.toISOString() : null,
        partialText: blocksToText(partialBlocks),
        partialBlocks,
      }),
    );
  });

  // Stop. The database decides: whoever ends the run first wins, and what was already written is kept.
  router.post("/runs/:runId/cancel", async (req, res) => {
    const id = IdSchema.safeParse(req.params.runId);
    if (!id.success) throw noActiveRun();
    const run = await prisma.agentRun.findFirst({
      where: { id: id.data, userId: currentUserId(res), status: { in: [...ACTIVE_STATUSES] } },
      select: { id: true, triggerRunId: true },
    });
    addLogContext({ runId: id.data });
    if (!run || !(await finalizeRun(run.id, { status: "CANCELLED" }))) throw noActiveRun();
    logger.info("run cancelled by the user");
    if (run.triggerRunId) await cancelTriggerRun(run.triggerRunId); // stop the task too; the answer above does not depend on it
    res.status(204).end();
  });

  // Try again: the same question, a new reply (see retryRun for the rules).
  router.post("/runs/:runId/retry", sendLimit, async (req, res) => {
    const id = IdSchema.safeParse(req.params.runId);
    if (!id.success) throw new AppError("NOT_FOUND", "That reply isn't there any more.");
    addLogContext({ runId: id.data });

    const turn = await retryRun({ userId: currentUserId(res), runId: id.data, traceId: logContext.getStore()?.traceId ?? randomUUID() });
    addLogContext({ chatId: turn.message.chatId, runId: turn.runId, messageId: turn.message.id });
    logger.info({ retryOf: id.data, replayed: turn.replayed, triggerRunId: turn.triggerRunId }, turn.replayed ? "retry already started" : "retry started");

    const { token, expiresAt } = await realtimeAccess(turn.triggerRunId);
    res.status(turn.replayed ? 200 : 201).json(
      RetryRunResponseSchema.parse({
        message: turn.message,
        chatId: turn.message.chatId,
        runId: turn.runId,
        triggerRunId: turn.triggerRunId,
        realtimeToken: token,
        realtimeTokenExpiresAt: expiresAt.toISOString(),
      }),
    );
  });

  return router;
}
