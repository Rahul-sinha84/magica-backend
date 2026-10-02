import { Router } from "express";
import { currentUserId } from "#src/auth/middleware.js";
import { RespondWaitpointBodySchema, RespondWaitpointResponseSchema } from "#src/contracts/index.js";
import { AppError } from "#src/lib/errors.js";
import { IdSchema } from "#src/lib/cursor.js";
import { addLogContext, logger } from "#src/lib/logger.js";
import { completeWaitpointToken } from "#src/lib/trigger.js";
import { respondToWaitpoint } from "#src/services/waitpoints.js";

export const waitpointsRouter = Router();

// The user's answer to what a run is waiting on: approve a plan or a spend, request changes, or reject.
waitpointsRouter.post("/:waitpointId/respond", async (req, res) => {
  const id = IdSchema.safeParse(req.params.waitpointId);
  if (!id.success) throw new AppError("NOT_FOUND", "That approval isn't there any more.");
  addLogContext({ waitpointId: id.data });
  const body = RespondWaitpointBodySchema.parse(req.body);
  const waitpoint = await respondToWaitpoint(currentUserId(res), id.data, body, { completeToken: completeWaitpointToken });
  addLogContext({ runId: waitpoint.runId });
  logger.info({ action: body.action, status: waitpoint.status }, "waitpoint answered");
  res.json(RespondWaitpointResponseSchema.parse({ waitpoint }));
});
