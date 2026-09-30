import { Router } from "express";
import { currentUserId } from "#src/auth/middleware.js";
import { ActiveRunResponseSchema, ContentBlocksSchema, blocksToText } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { AppError } from "#src/lib/errors.js";
import { addLogContext, logger } from "#src/lib/logger.js";
import { IdSchema } from "#src/lib/cursor.js";
import { cancelTriggerRun } from "#src/lib/trigger.js";
import { parseChatId, requireChat } from "#src/services/chats.js";
import { reconcileRun } from "#src/services/reconcile.js";
import { ACTIVE_STATUSES, finalizeRun, findActiveRun } from "#src/services/runs.js";
import { realtimeAccess } from "#src/services/turns.js";

export const runsRouter = Router();

const noActiveRun = () => new AppError("NOT_FOUND", "That run isn't active.");

// What the client asks on load and while it waits: is a run going for this chat, and what has it written so far?
// Only a run in flight is returned; `run: null` means it is over (or there never was one), and the client then fetches
// the finished messages.
runsRouter.get("/chats/:chatId/active-run", async (req, res) => {
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
runsRouter.post("/runs/:runId/cancel", async (req, res) => {
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
