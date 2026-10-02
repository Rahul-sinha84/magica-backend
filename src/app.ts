import express, { type Express } from "express";
import type { Logger } from "pino";
import helmet from "helmet";
import { clerkAuth } from "#src/auth/clerk.js";
import { requireUser } from "#src/auth/middleware.js";
import { env } from "#src/env/server.js";
import { logger } from "#src/lib/logger.js";
import { corsMiddleware } from "#src/middleware/cors.js";
import { errorHandler, notFound } from "#src/middleware/errorHandler.js";
import { createApiRateLimit, createMessageSendRateLimit, type ApiLimits } from "#src/middleware/rateLimit.js";
import { requestContext } from "#src/middleware/requestContext.js";
import { chatsRouter } from "#src/routes/chats.js";
import { messagesRouter } from "#src/routes/messages.js";
import { runsRouter } from "#src/routes/runs.js";
import { creditsRouter } from "#src/routes/credits.js";
import { modelsRouter } from "#src/routes/models.js";
import { mediaRouter } from "#src/routes/media.js";
import { uploadNotificationsRouter, uploadsRouter } from "#src/routes/uploads.js";
import { waitpointsRouter } from "#src/routes/waitpoints.js";
import { apiKeysRouter } from "#src/routes/apiKeys.js";
import { v1Router } from "#src/routes/v1.js";
import type { FetchAssembly } from "#src/lib/transloadit.js";
import { healthRouter } from "#src/routes/health.js";

// `fetchAssembly` (how Transloadit is asked about an upload) and `completionWaitMs` are only replaced in tests.
export function createApp({
  log = logger,
  rateLimits,
  sendLimit,
  fetchAssembly,
  completionWaitMs,
}: { log?: Logger; rateLimits?: ApiLimits; sendLimit?: number; fetchAssembly?: FetchAssembly; completionWaitMs?: number } = {}): Express {
  const app = express();
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(requestContext(log));
  app.use(helmet());
  app.use(corsMiddleware()); // answers preflight requests itself, before anything below can reject them

  app.use("/api/health", healthRouter);
  // Transloadit's server-to-server reports: no user session, proven by an HMAC with our secret instead
  app.use("/api/uploads/notify", uploadNotificationsRouter);

  // Order matters. A request is verified and counted before anything is read or written on its behalf, so an
  // unauthenticated client can't make us parse a large body or touch the database.
  app.use(
    "/api",
    (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store"); // per-user data must never be cached by a proxy
      next();
    },
    clerkAuth(),
    createApiRateLimit(rateLimits),
    requireUser,
    express.json({ limit: "1mb" }),
  );
  // one limiter for everything that starts a turn (sending and retrying), so the two share the same allowance
  const startsTurn = createMessageSendRateLimit(sendLimit === undefined ? {} : { limit: sendLimit });
  app.use("/api/chats/:chatId/messages", messagesRouter(startsTurn));
  app.use("/api/chats", chatsRouter);
  app.use("/api", runsRouter(startsTurn));
  app.use("/api/credits", creditsRouter);
  app.use("/api/models", modelsRouter);
  app.use("/api/uploads", uploadsRouter(fetchAssembly ? { fetchAssembly } : {}));
  app.use("/api/media", mediaRouter);
  app.use("/api/waitpoints", waitpointsRouter);
  app.use("/api/api-keys", apiKeysRouter);
  // the public API: its own way in (API keys or a session token), its own limits, errors that carry the trace id
  app.use("/v1", v1Router({ sessionAuth: clerkAuth(), sendLimit: startsTurn, ...(completionWaitMs !== undefined && { completionWaitMs }) }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
