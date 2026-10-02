import { AsyncLocalStorage } from "node:async_hooks";
import { hostname } from "node:os";
import { pino, stdSerializers, transport, type DestinationStream, type Logger } from "pino";
import { env } from "#src/env/base.js";
import { Prisma } from "#src/generated/prisma/client.js";
import { constraintOf } from "#src/lib/errors.js";

/** Fields attached to every log line written while handling one request or one agent run. */
export interface LogContext {
  traceId: string;
  userId?: string;
  chatId?: string;
  runId?: string;
  messageId?: string;
  waitpointId?: string;
}

export const logContext = new AsyncLocalStorage<LogContext>();

/** Adds fields to the current context (for example chatId once it is known). No-op outside a context. */
export function addLogContext(fields: Partial<LogContext>): void {
  const store = logContext.getStore();
  if (store) Object.assign(store, fields);
}

// Prisma's error `meta` carries Postgres's "Failing row contains (...)" text, which includes user data such as
// emails and balances. Keep what is useful for debugging (the code and which constraint) and drop the rest.
export function serializeError(error: unknown): unknown {
  const serialized = stdSerializers.err(error as Error);
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return serialized;
  const { meta: _meta, ...safe } = serialized as typeof serialized & { meta?: unknown };
  return { ...safe, constraint: constraintOf(error) };
}

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    // `processId` (pino calls it `pid` by default) is one of the fields every log line is required to carry
    { level, base: { processId: process.pid, hostname: hostname() }, mixin: () => ({ ...logContext.getStore() }), serializers: { err: serializeError } },
    destination,
  );
}

/**
 * Pretty, human-readable output for local development. `pino-pretty` is a dev-only dependency, so a deploy that
 * forgot to set NODE_ENV (which defaults to "development") falls back to plain JSON instead of crashing at startup.
 */
export function prettyTransport(resolve: (name: string) => string = (name) => import.meta.resolve(name)): DestinationStream | undefined {
  try {
    resolve("pino-pretty");
  } catch {
    return undefined;
  }
  return transport({ target: "pino-pretty" });
}

export const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === "development" ? prettyTransport() : undefined);
