import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError, toErrorResponse } from "#src/lib/errors.js";
import { logger } from "#src/lib/logger.js";

export const notFound: RequestHandler = () => {
  throw new AppError("NOT_FOUND", "That route doesn't exist.");
};

// Express identifies error handlers by their four parameters, so `_next` must stay even though it is unused.
export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error); // too late to send a JSON body; let Express close the connection
    return;
  }
  const { status, body, unexpected } = toErrorResponse(error);
  const fields = { status, code: body.code, method: req.method, path: req.originalUrl.split("?")[0] };
  if (unexpected) logger.error({ ...fields, err: error }, "request failed");
  else logger.info(fields, "request rejected");
  res.status(status).json(body);
};
