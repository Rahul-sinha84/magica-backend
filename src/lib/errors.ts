import { z } from "zod";
import type { ErrorCode, ErrorResponse } from "#src/contracts/index.js";
import { Prisma } from "#src/generated/prisma/client.js";

/** Exactly one HTTP status per code, so a client can rely on either to tell what happened. */
export const ERROR_STATUS = {
  UNAUTHORIZED: 401,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  RUN_ACTIVE: 409,
  INSUFFICIENT_CREDITS: 402,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
} as const satisfies Record<ErrorCode, number>;

/** An error whose message is safe to show to the user. Everything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export interface MappedError {
  status: number;
  body: ErrorResponse;
  /** True when this is our bug or an outage rather than the caller's mistake: logged as an error with the stack. */
  unexpected: boolean;
}

const INTERNAL_MESSAGE = "Something went wrong on our side. Please try again.";

const mapped = (code: ErrorCode, error: string, details?: Record<string, unknown>): MappedError => ({
  status: ERROR_STATUS[code],
  body: { error, code, ...(details && { details }) },
  unexpected: code === "INTERNAL_ERROR" || code === "SERVICE_UNAVAILABLE",
});

/** The database constraint behind a Prisma error, read from the driver-adapter payload. */
export function constraintOf(error: Prisma.PrismaClientKnownRequestError): string | undefined {
  const cause = (error.meta?.driverAdapterError as { cause?: { constraint?: { index?: string }; originalMessage?: string } } | undefined)?.cause;
  return cause?.constraint?.index ?? /constraint "([^"]+)"/.exec(cause?.originalMessage ?? "")?.[1];
}

// Errors that mean "we can't use the database right now" rather than "this request was wrong": retryable, so 503.
const NODE_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE"]);
const PRISMA_UNAVAILABLE_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]); // unreachable, timed out, pool timeout
// SQLSTATE classes: 08 connection problems, 53 out of resources (too many connections), 57 operator intervention
// (57014 is a statement timeout), plus bad credentials and a missing database (a misconfigured deployment)
const isUnavailableSqlState = (state?: string) => !!state && (/^(08|53|57)/.test(state) || ["28P01", "28000", "3D000"].includes(state));
const PG_CONNECTION_MESSAGE = /Connection terminated|timeout exceeded when trying to connect|Connection ended unexpectedly/i;

export function isDatabaseUnavailable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const cause = (error.meta?.driverAdapterError as { cause?: { originalCode?: string } } | undefined)?.cause;
    return NODE_NETWORK_CODES.has(error.code) || PRISMA_UNAVAILABLE_CODES.has(error.code) || isUnavailableSqlState(cause?.originalCode);
  }
  return error instanceof Error && PG_CONNECTION_MESSAGE.test(error.message);
}

function fromPrisma(error: Prisma.PrismaClientKnownRequestError): MappedError {
  const constraint = constraintOf(error);
  // These three are "someone else got there first" or "that is gone": a safety net for routes that forget to handle them.
  if (constraint === "AgentRun_one_active_per_chat") return mapped("RUN_ACTIVE", "An agent is already running in this chat.");
  if (constraint === "User_credits_valid") return mapped("INSUFFICIENT_CREDITS", "You don't have enough credits for that.");
  if (error.code === "P2025" || error.code === "P2003") return mapped("NOT_FOUND", "That couldn't be found.");
  return mapped("INTERNAL_ERROR", INTERNAL_MESSAGE);
}

// body-parser tags its errors with a `type`; anything else that carries a status is not ours to interpret.
function fromBodyParser(error: unknown): MappedError | undefined {
  const type = typeof error === "object" && error !== null && "type" in error ? error.type : undefined;
  if (type === "entity.parse.failed") return mapped("VALIDATION_FAILED", "The request body isn't valid JSON.");
  if (type === "entity.too.large") return mapped("PAYLOAD_TOO_LARGE", "That request is too large.");
  if (type === "request.aborted" || type === "encoding.unsupported" || type === "charset.unsupported") {
    return mapped("VALIDATION_FAILED", "The request body couldn't be read.");
  }
  return undefined;
}

/** Turns anything that was thrown into the response we send. Never exposes stacks, SQL or row data. */
export function toErrorResponse(error: unknown): MappedError {
  if (error instanceof AppError) return mapped(error.code, error.message, error.details);

  if (error instanceof z.ZodError) {
    const { fieldErrors, formErrors } = z.flattenError(error as z.ZodError<Record<string, unknown>>);
    const [field, messages] = Object.entries(fieldErrors)[0] ?? [];
    const first = messages?.[0] ?? formErrors[0] ?? "The request isn't valid.";
    return mapped("VALIDATION_FAILED", field ? `${field}: ${first}` : first, { fields: fieldErrors, ...(formErrors.length > 0 && { form: formErrors }) });
  }

  if (isDatabaseUnavailable(error)) return mapped("SERVICE_UNAVAILABLE", "We're having trouble reaching our database. Please try again in a moment.");

  if (error instanceof Prisma.PrismaClientKnownRequestError) return fromPrisma(error);

  return fromBodyParser(error) ?? mapped("INTERNAL_ERROR", INTERNAL_MESSAGE);
}
