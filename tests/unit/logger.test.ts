import { describe, expect, it } from "vitest";
import { Prisma } from "#src/generated/prisma/client.js";
import { addLogContext, createLogger, logContext, prettyTransport } from "#src/lib/logger.js";
import { applyServerTimeouts } from "#src/lib/serverTimeouts.js";
import { createServer } from "node:http";

function capture() {
  const chunks: string[] = [];
  return { log: createLogger("info", { write: (c: string) => void chunks.push(c) }), text: () => chunks.join(""), last: () => JSON.parse(chunks.at(-1) ?? "{}") as Record<string, Record<string, unknown>> };
}

const dbError = () =>
  new Prisma.PrismaClientKnownRequestError("Database error. Code: `23514`", {
    code: "P2039",
    clientVersion: "7.10.0",
    meta: {
      driverAdapterError: {
        cause: {
          originalCode: "23514",
          originalMessage: 'new row for relation "User" violates check constraint "User_credits_valid"',
          detail: "Failing row contains (user_1, ada@example.com, 30000000, 100000, 2026-09-30)",
        },
      },
    },
  });

describe("log lines", () => {
  it("carry the request's context, but a line's own fields never leak into the lines after it", () => {
    const chunks: string[] = [];
    const log = createLogger("info", { write: (c: string) => void chunks.push(c) });
    const lines = () => chunks.map((c) => JSON.parse(c) as Record<string, unknown>);
    logContext.run({ traceId: "t1", runId: "r1" }, () => {
      log.info({ skills: ["a"], rejected: 0 }, "skills available");
      log.warn({ failure: "RATE_LIMITED", detail: "429" }, "the model could not answer");
      log.info("run ended");
      expect(logContext.getStore()).toEqual({ traceId: "t1", runId: "r1" }); // the shared context is untouched
    });
    expect(lines()[0]).toMatchObject({ traceId: "t1", runId: "r1", skills: ["a"], rejected: 0 });
    expect(lines()[1]).toMatchObject({ traceId: "t1", failure: "RATE_LIMITED" });
    expect(lines()[1]).not.toHaveProperty("skills");
    expect(lines()[2]).toMatchObject({ traceId: "t1", runId: "r1", msg: "run ended" });
    for (const key of ["skills", "rejected", "failure", "detail"]) expect(lines()[2]).not.toHaveProperty(key);
  });

  it("still picks up context added later with addLogContext", () => {
    const chunks: string[] = [];
    const log = createLogger("info", { write: (c: string) => void chunks.push(c) });
    logContext.run({ traceId: "t2" }, () => {
      addLogContext({ chatId: "c1" });
      log.info("hello");
    });
    expect(JSON.parse(chunks[0] ?? "{}")).toMatchObject({ traceId: "t2", chatId: "c1" });
  });

  it("work outside any request context", () => {
    const chunks: string[] = [];
    createLogger("info", { write: (c: string) => void chunks.push(c) }).info({ a: 1 }, "outside");
    expect(JSON.parse(chunks[0] ?? "{}")).toMatchObject({ a: 1, msg: "outside" });
  });

  it("carry the process id as processId (one of the required log fields) and the host", () => {
    const { log, last } = capture();
    log.info("hello");
    expect(last()).toMatchObject({ processId: process.pid, msg: "hello" });
    expect(typeof last().hostname).toBe("string");
    expect(last()).not.toHaveProperty("pid");
  });
});

describe("error logging", () => {
  it("keeps the code and constraint of a database error but never the row data", () => {
    const { log, text, last } = capture();
    log.error({ err: dbError() }, "request failed");
    expect(text()).not.toContain("ada@example.com");
    expect(text()).not.toContain("Failing row");
    expect(last().err).toMatchObject({ code: "P2039", constraint: "User_credits_valid", type: "PrismaClientKnownRequestError" });
    expect(last().err).not.toHaveProperty("meta");
  });

  it("still includes the stack, which is what makes the log useful", () => {
    const { log, last } = capture();
    log.error({ err: dbError() }, "request failed");
    expect(String(last().err?.stack)).toContain("PrismaClientKnownRequestError");
  });

  it("logs an ordinary error with its message and stack", () => {
    const { log, last } = capture();
    log.error({ err: new Error("kaboom") }, "request failed");
    expect(last().err).toMatchObject({ type: "Error", message: "kaboom" });
    expect(String(last().err?.stack)).toContain("kaboom");
  });

  it("copes with a thrown value that is not an Error", () => {
    const { log, text } = capture();
    expect(() => log.error({ err: "just a string" }, "request failed")).not.toThrow();
    expect(text()).toContain("request failed");
  });
});

describe("prettyTransport", () => {
  it("falls back to plain JSON logging when pino-pretty is not installed (a production install)", () => {
    const resolve = (name: string): string => {
      throw new Error(`Cannot find package '${name}'`);
    };
    expect(prettyTransport(resolve)).toBeUndefined();
  });

  it("looks for pino-pretty by name", () => {
    const seen: string[] = [];
    try {
      prettyTransport((name) => {
        seen.push(name);
        throw new Error("stop here: only checking what is asked for");
      });
    } catch {
      /* not expected to throw */
    }
    expect(seen).toEqual(["pino-pretty"]);
  });
});

describe("applyServerTimeouts", () => {
  it("sheds slow clients and keeps connections alive longer than a load balancer's idle timeout", () => {
    const server = createServer();
    applyServerTimeouts(server);
    expect(server.requestTimeout).toBe(30_000);
    expect(server.keepAliveTimeout).toBeGreaterThan(60_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    server.close();
  });
});
