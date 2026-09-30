import type { Server } from "node:http";
import type { Logger } from "pino";
import { logger } from "#src/lib/logger.js";

export interface ShutdownOptions {
  /** Runs after the server has stopped accepting and finished its requests (for example closing the database). */
  cleanup?: () => Promise<void>;
  /** How long in-flight requests get before the process is stopped anyway. */
  graceMs?: number;
  exit?: (code: number) => void;
  log?: Logger;
}

/**
 * Returns the function to call on SIGTERM / SIGINT: it stops accepting connections, lets requests that are already
 * running finish, cleans up, then exits. A request that never finishes cannot keep the process alive past `graceMs`,
 * and a second signal (Ctrl-C twice) stops it immediately.
 */
export function createShutdown(server: Server, { cleanup = async () => {}, graceMs = 10_000, exit = (code) => process.exit(code), log = logger }: ShutdownOptions = {}) {
  let started = false;
  return (signal: string): void => {
    if (started) {
      log.warn({ signal }, "second signal: stopping immediately");
      exit(1);
      return;
    }
    started = true;
    log.info({ signal }, "shutting down: finishing in-flight requests");

    setTimeout(() => {
      log.error("shutdown grace period exceeded; forcing exit");
      exit(1);
    }, graceMs).unref();

    server.close((error) => {
      void cleanup()
        .catch((err: unknown) => log.error({ err }, "cleanup failed during shutdown"))
        .finally(() => exit(error ? 1 : 0));
    });
    server.closeIdleConnections(); // keep-alive connections with nothing running must not hold shutdown open
  };
}
