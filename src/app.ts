import express, { type Express } from "express";
import type { Logger } from "pino";
import helmet from "helmet";
import { clerkAuth } from "#src/auth/clerk.js";
import { requireUser } from "#src/auth/middleware.js";
import { env } from "#src/env/server.js";
import { logger } from "#src/lib/logger.js";
import { corsMiddleware } from "#src/middleware/cors.js";
import { errorHandler, notFound } from "#src/middleware/errorHandler.js";
import { createApiRateLimit } from "#src/middleware/rateLimit.js";
import { requestContext } from "#src/middleware/requestContext.js";
import { creditsRouter } from "#src/routes/credits.js";
import { healthRouter } from "#src/routes/health.js";

export function createApp({ log = logger }: { log?: Logger } = {}): Express {
  const app = express();
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(requestContext(log));
  app.use(helmet());
  app.use(corsMiddleware()); // answers preflight requests itself, before anything below can reject them

  app.use("/api/health", healthRouter);

  // Order matters. A request is verified and counted before anything is read or written on its behalf, so an
  // unauthenticated client can't make us parse a large body or touch the database.
  app.use(
    "/api",
    (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store"); // per-user data must never be cached by a proxy
      next();
    },
    clerkAuth(),
    createApiRateLimit(),
    requireUser,
    express.json({ limit: "1mb" }),
  );
  app.use("/api/credits", creditsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
