import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import { logContext, logger } from "#src/lib/logger.js";

// Only accept an id we could have generated ourselves: it is echoed in headers and written to logs.
const TRACE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Gives each request a trace id (from `x-trace-id` if it is well-formed), echoes it, and logs the request once it ends. */
export const requestContext =
  (log: Logger = logger): RequestHandler =>
  (req, res, next) => {
    const incoming = req.get("x-trace-id");
    const traceId = incoming && TRACE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader("x-trace-id", traceId);

    const store = { traceId };
    const started = performance.now();
    const path = req.originalUrl.split("?")[0]; // never log the query string

    res.on("close", () => {
      logContext.run(store, () => {
        const fields = { method: req.method, path, durationMs: Math.round(performance.now() - started) };
        // no status when aborted: nothing was sent, and the default 200 would be misleading
        if (!res.writableFinished) log.warn(fields, "request aborted by the client");
        else (path === "/api/health" ? log.debug : log.info).call(log, { ...fields, status: res.statusCode }, "request");
      });
    });

    logContext.run(store, next);
  };
