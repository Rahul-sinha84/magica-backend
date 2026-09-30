import { describe, expect, it } from "vitest";
import { ServerEnvSchema, WorkerEnvSchema, parseEnv } from "#src/env/schema.js";

const db = { DATABASE_URL: "postgresql://magica:magica@localhost:5432/magica_dev" };
const server = {
  ...db,
  CLERK_SECRET_KEY: "sk_test_abc",
  CLERK_PUBLISHABLE_KEY: "pk_test_abc",
  TRIGGER_SECRET_KEY: "tr_dev_abc",
};
const worker = { ...db, OPENROUTER_API_KEY: "sk-or-abc" };

const parseServer = (overrides: Record<string, string | undefined> = {}) =>
  parseEnv(ServerEnvSchema, { ...server, ...overrides });

describe("server env", () => {
  it("parses a valid env and applies defaults", () => {
    expect(parseServer()).toMatchObject({
      NODE_ENV: "development",
      PORT: 3000,
      OPENROUTER_MODEL: "openrouter/free",
      FRONTEND_ORIGIN: "http://localhost:3001",
      CREDIT_STARTING_BALANCE: 30_000_000,
      CREDIT_ADMISSION_HOLD: 100_000,
    });
  });

  it("does not require worker-only keys", () => {
    expect(() => parseServer()).not.toThrow();
  });

  it("names the missing key in the error", () => {
    expect(() => parseServer({ CLERK_SECRET_KEY: undefined })).toThrow(/CLERK_SECRET_KEY/);
  });

  it.each(["openrouter/auto", "openai/gpt-4o", "openrouter/free:paid"])("rejects model %s", (model) => {
    expect(() => parseServer({ OPENROUTER_MODEL: model })).toThrow(/openrouter\/free/);
  });

  it("treats blank values as missing", () => {
    expect(() => parseServer({ TRIGGER_SECRET_KEY: "   " })).toThrow(/TRIGGER_SECRET_KEY/);
    expect(parseServer({ PORT: "" }).PORT).toBe(3000);
  });

  it("trims surrounding whitespace from keys", () => {
    expect(parseServer({ CLERK_SECRET_KEY: "  sk_test_abc \n" }).CLERK_SECRET_KEY).toBe("sk_test_abc");
  });

  it.each(["abc", "0", "70000", "3000.5"])("rejects PORT=%s", (port) => {
    expect(() => parseServer({ PORT: port })).toThrow(/PORT/);
  });

  it("rejects non-postgres database URLs", () => {
    expect(() => parseServer({ DATABASE_URL: "mysql://u:p@localhost/db" })).toThrow(/DATABASE_URL/);
  });

  it("rejects swapped Clerk keys", () => {
    expect(() =>
      parseServer({ CLERK_SECRET_KEY: server.CLERK_PUBLISHABLE_KEY, CLERK_PUBLISHABLE_KEY: server.CLERK_SECRET_KEY }),
    ).toThrow(/CLERK_SECRET_KEY/);
  });

  it("rejects an admission hold larger than the starting balance", () => {
    expect(() => parseServer({ CREDIT_STARTING_BALANCE: "100", CREDIT_ADMISSION_HOLD: "101" })).toThrow(
      /CREDIT_ADMISSION_HOLD/,
    );
  });
});

describe("worker env", () => {
  it("parses without Clerk or Trigger keys", () => {
    expect(parseEnv(WorkerEnvSchema, worker)).toMatchObject({
      OPENROUTER_MODEL: "openrouter/free",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    });
  });

  it("requires the OpenRouter key", () => {
    expect(() => parseEnv(WorkerEnvSchema, db)).toThrow(/OPENROUTER_API_KEY/);
  });

  it("rejects paid models too", () => {
    expect(() => parseEnv(WorkerEnvSchema, { ...worker, OPENROUTER_MODEL: "openrouter/auto" })).toThrow(
      /openrouter\/free/,
    );
  });
});
