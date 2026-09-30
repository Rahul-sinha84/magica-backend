import { createApp } from "#src/app.js";
import { prisma } from "#src/db/client.js";
import { env } from "#src/env/server.js";
import { createShutdown } from "#src/lib/lifecycle.js";
import { logger } from "#src/lib/logger.js";
import { applyServerTimeouts } from "#src/lib/serverTimeouts.js";

// No callback on listen(): Express 5 also calls it when listening fails, which would log "started" for a dead server.
const server = createApp().listen(env.PORT);
applyServerTimeouts(server);

server.once("listening", () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV, frontend: env.FRONTEND_ORIGIN }, "server started");
});

server.once("error", (err: NodeJS.ErrnoException) => {
  logger.fatal({ err }, err.code === "EADDRINUSE" ? `port ${env.PORT} is already in use` : "server failed to start");
  process.exit(1);
});

const shutdown = createShutdown(server, { cleanup: () => prisma.$disconnect() });
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled promise rejection");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  process.exit(1);
});
