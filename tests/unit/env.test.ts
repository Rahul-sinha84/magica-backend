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

  it("trims values, including the model name", () => {
    expect(parseServer({ OPENROUTER_MODEL: " openrouter/free\n" }).OPENROUTER_MODEL).toBe("openrouter/free");
  });

  it.each(["postgres://u:p@h:5432/d", "postgresql://u:p@h/d?sslmode=require"])("accepts database URL %s", (url) => {
    expect(parseServer({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it("does not leak the database password in errors", () => {
    expect(() => parseServer({ DATABASE_URL: "postgresql://magica:SECRETPW@:bad" })).toThrow(/^(?!.*SECRETPW)/s);
  });

  it.each([
    ["http://localhost:3001/", "http://localhost:3001"],
    ["http://localhost:3001/app?x=1", "http://localhost:3001"],
    ["https://magica.example.com", "https://magica.example.com"],
  ])("normalises FRONTEND_ORIGIN %s to an exact origin", (input, expected) => {
    expect(parseServer({ FRONTEND_ORIGIN: input }).FRONTEND_ORIGIN).toBe(expected);
  });

  it.each(["ftp://x.com", "localhost:3001", "not a url"])("rejects FRONTEND_ORIGIN %s", (origin) => {
    expect(() => parseServer({ FRONTEND_ORIGIN: origin })).toThrow(/FRONTEND_ORIGIN/);
  });

  it.each(["3000000000", "30,000,000", "0", "-5", "1.5"])("rejects CREDIT_STARTING_BALANCE=%s", (v) => {
    expect(() => parseServer({ CREDIT_STARTING_BALANCE: v })).toThrow(/CREDIT_STARTING_BALANCE/);
  });

  it("accepts the largest Postgres INTEGER balance", () => {
    expect(parseServer({ CREDIT_STARTING_BALANCE: "2147483647" }).CREDIT_STARTING_BALANCE).toBe(2_147_483_647);
  });

  it.each([["0", 0], ["1", 1], ["10", 10]])("accepts TRUST_PROXY=%s", (value, expected) => {
    expect(parseServer({ TRUST_PROXY: value }).TRUST_PROXY).toBe(expected);
  });

  it("defaults TRUST_PROXY to 0 (no proxy) and rejects nonsense", () => {
    expect(parseServer().TRUST_PROXY).toBe(0);
    for (const bad of ["-1", "11", "yes", "1.5"]) expect(() => parseServer({ TRUST_PROXY: bad })).toThrow(/TRUST_PROXY/);
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
