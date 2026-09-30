import { describe, expect, it } from "vitest";
import { ErrorCodeSchema, ErrorResponseSchema, SendMessageBodySchema } from "#src/contracts/index.js";
import { Prisma } from "#src/generated/prisma/client.js";
import { AppError, ERROR_STATUS, constraintOf, toErrorResponse } from "#src/lib/errors.js";

const prismaError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError("irrelevant", { code, clientVersion: "7.10.0", ...(meta && { meta }) });

// the shapes Prisma 7 really produces with the pg driver adapter (captured from the test database)
const uniqueViolation = (index: string) =>
  prismaError("P2002", { driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { index } } } });
const foreignKeyViolation = prismaError("P2003", {
  driverAdapterError: { cause: { kind: "ForeignKeyConstraintViolation", constraint: { index: "Chat_userId_fkey" } } },
});
const checkViolation = (name: string) =>
  prismaError("P2039", {
    driverAdapterError: {
      cause: { originalCode: "23514", originalMessage: `new row for relation "User" violates check constraint "${name}"`, detail: "Failing row contains (user_1, secret@example.com, 5)" },
    },
  });

describe("ERROR_STATUS", () => {
  it("covers every error code in the contract, and only those", () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ErrorCodeSchema.options].sort());
  });

  it("maps each code to its own status (one-to-one, so either one identifies the other)", () => {
    const statuses = Object.values(ERROR_STATUS);
    expect(new Set(statuses).size).toBe(statuses.length);
  });

  it("uses only real client (4xx) and server (5xx) statuses", () => {
    for (const status of Object.values(ERROR_STATUS)) expect(status >= 400 && status < 600).toBe(true);
  });

  it("gives AppError the status of its code", () => {
    expect(new AppError("RATE_LIMITED", "slow down").status).toBe(429);
  });
});

describe("toErrorResponse", () => {
  const cases: [string, unknown][] = [
    ["AppError", new AppError("NOT_FOUND", "Chat not found.", { chatId: "c1" })],
    ["ZodError", SendMessageBodySchema.safeParse({ content: "" }).error],
    ["body-parser parse error", Object.assign(new SyntaxError("Unexpected token"), { type: "entity.parse.failed" })],
    ["body-parser too large", Object.assign(new Error("too big"), { type: "entity.too.large" })],
    ["active-run race", uniqueViolation("AgentRun_one_active_per_chat")],
    ["other unique violation", uniqueViolation("CreditLedger_idempotencyKey_key")],
    ["foreign key violation", foreignKeyViolation],
    ["record not found", prismaError("P2025")],
    ["credits check violation", checkViolation("User_credits_valid")],
    ["other check violation", checkViolation("CreditLedger_amount_nonzero")],
    ["plain Error", new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2")],
    ["thrown string", "boom"],
    ["null", null],
    ["undefined", undefined],
  ];

  it.each(cases)("produces a valid, status-consistent response for: %s", (_label, error) => {
    const { status, body } = toErrorResponse(error);
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(status).toBe(ERROR_STATUS[body.code]);
  });

  it("keeps an AppError's own message and details", () => {
    expect(toErrorResponse(new AppError("NOT_FOUND", "Chat not found.", { chatId: "c1" }))).toMatchObject({
      status: 404,
      unexpected: false,
      body: { error: "Chat not found.", code: "NOT_FOUND", details: { chatId: "c1" } },
    });
  });

  describe("validation errors", () => {
    it("names the first bad field and lists every field error", () => {
      const { status, body } = toErrorResponse(SendMessageBodySchema.safeParse({ content: "  ", clientMessageId: "nope" }).error);
      expect(status).toBe(400);
      expect(body.code).toBe("VALIDATION_FAILED");
      expect(body.error).toMatch(/^content: Message can't be empty\.$/);
      const fields = body.details?.fields as Record<string, string[]>;
      expect(fields.content).toEqual(["Message can't be empty."]);
      expect(fields.clientMessageId?.length).toBeGreaterThan(0);
    });

    it("handles a problem with the body as a whole (not an object)", () => {
      const { body } = toErrorResponse(SendMessageBodySchema.safeParse("just text").error);
      expect(body.code).toBe("VALIDATION_FAILED");
      expect(body.error).not.toBe("");
    });
  });

  describe("body-parser errors", () => {
    it("maps bad JSON to 400 and an oversized body to 413", () => {
      expect(toErrorResponse(Object.assign(new Error("x"), { type: "entity.parse.failed" })).status).toBe(400);
      expect(toErrorResponse(Object.assign(new Error("x"), { type: "entity.too.large" }))).toMatchObject({ status: 413, body: { code: "PAYLOAD_TOO_LARGE" } });
    });

    it("maps aborted and unsupported-encoding bodies to 400", () => {
      for (const type of ["request.aborted", "encoding.unsupported", "charset.unsupported"]) {
        expect(toErrorResponse(Object.assign(new Error("x"), { type })).status).toBe(400);
      }
    });

    it("does not trust an unknown error just because it carries a status", () => {
      const { status, body } = toErrorResponse(Object.assign(new Error("teapot"), { status: 418, type: "something.else" }));
      expect(status).toBe(500);
      expect(body.code).toBe("INTERNAL_ERROR");
    });
  });

  describe("database errors (safety nets for routes that forget to handle them)", () => {
    it("reads the constraint name from the driver payload, or from the message as a fallback", () => {
      expect(constraintOf(uniqueViolation("AgentRun_one_active_per_chat"))).toBe("AgentRun_one_active_per_chat");
      expect(constraintOf(foreignKeyViolation)).toBe("Chat_userId_fkey");
      expect(constraintOf(checkViolation("User_credits_valid"))).toBe("User_credits_valid");
      expect(constraintOf(prismaError("P2025"))).toBeUndefined();
    });

    it("turns the one-active-run index into 409 RUN_ACTIVE", () => {
      expect(toErrorResponse(uniqueViolation("AgentRun_one_active_per_chat"))).toMatchObject({ status: 409, body: { code: "RUN_ACTIVE" }, unexpected: false });
    });

    it("turns the credits CHECK into 402 INSUFFICIENT_CREDITS", () => {
      expect(toErrorResponse(checkViolation("User_credits_valid"))).toMatchObject({ status: 402, body: { code: "INSUFFICIENT_CREDITS" } });
    });

    it("turns a missing record or parent into 404", () => {
      expect(toErrorResponse(prismaError("P2025")).status).toBe(404);
      expect(toErrorResponse(foreignKeyViolation).status).toBe(404);
    });

    it("treats any other database error as an unexpected 500", () => {
      for (const error of [uniqueViolation("CreditLedger_idempotencyKey_key"), checkViolation("CreditLedger_amount_nonzero"), prismaError("P2021")]) {
        expect(toErrorResponse(error)).toMatchObject({ status: 500, unexpected: true, body: { code: "INTERNAL_ERROR" } });
      }
    });
  });

  describe("database outages become a retryable 503", () => {
    // the shapes Prisma 7 + the pg driver adapter really produce (captured from a live database)
    const refused = prismaError("ECONNREFUSED");
    const sqlState = (originalCode: string) => prismaError("P2010", { driverAdapterError: { cause: { originalCode } } });

    it.each([
      ["connection refused", refused],
      ["connection reset", prismaError("ECONNRESET")],
      ["host unreachable", prismaError("EHOSTUNREACH")],
      ["DNS failure", prismaError("ENOTFOUND")],
      ["Prisma: can't reach the database", prismaError("P1001")],
      ["Prisma: database timed out", prismaError("P1002")],
      ["Prisma: connection pool timeout", prismaError("P2024")],
      ["statement timeout (57014)", sqlState("57014")],
      ["server shutting down (57P01)", sqlState("57P01")],
      ["too many connections (53300)", sqlState("53300")],
      ["connection failure (08006)", sqlState("08006")],
      ["wrong database password (28P01)", sqlState("28P01")],
      ["database does not exist (3D000)", sqlState("3D000")],
      ["pg: connection terminated", new Error("Connection terminated due to connection timeout")],
      ["pg: pool wait timed out", new Error("timeout exceeded when trying to connect")],
      ["pg: connection ended", new Error("Connection terminated unexpectedly")],
    ])("%s", (_label, error) => {
      expect(toErrorResponse(error)).toMatchObject({ status: 503, unexpected: true, body: { code: "SERVICE_UNAVAILABLE" } });
    });

    it.each([
      ["a check violation", checkViolation("CreditLedger_amount_nonzero")],
      ["a unique violation", uniqueViolation("CreditLedger_idempotencyKey_key")],
      ["a syntax error (42601)", sqlState("42601")],
      ["a null violation (23502)", sqlState("23502")],
      ["an unrelated Error", new Error("undefined is not a function")],
    ])("is not applied to %s", (_label, error) => {
      expect(toErrorResponse(error).body.code).not.toBe("SERVICE_UNAVAILABLE");
    });

    it("does not leak the host, port or credentials", () => {
      const json = JSON.stringify(toErrorResponse(new Error("connect ECONNREFUSED 10.0.0.5:5432 Connection terminated password=hunter2")).body);
      expect(json).not.toMatch(/10\.0\.0\.5|5432|hunter2|ECONNREFUSED/);
    });
  });

  describe("never leaks internals", () => {
    const leaky = [
      new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"),
      checkViolation("CreditLedger_amount_nonzero"),
      uniqueViolation("CreditLedger_idempotencyKey_key"),
      prismaError("P2021", { secret: "hunter2" }),
    ];

    it.each(leaky.map((e, i) => [i, e] as const))("hides the details of unexpected error #%i", (_i, error) => {
      const json = JSON.stringify(toErrorResponse(error).body);
      for (const secret of ["hunter2", "ECONNREFUSED", "10.0.0.5", "secret@example.com", "Failing row", "stack", "CreditLedger", "idempotencyKey"]) {
        expect(json).not.toContain(secret);
      }
    });

    it("uses one generic message for every unexpected error", () => {
      const messages = new Set(leaky.map((e) => toErrorResponse(e).body.error));
      expect(messages.size).toBe(1);
    });
  });
});
