import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "#src/app.js";
import { clearUserCache, ensureUser } from "#src/auth/users.js";
import { CreditsResponseSchema, ErrorResponseSchema } from "#src/contracts/index.js";
import { Prisma, prisma } from "#src/db/client.js";
import { createLogger } from "#src/lib/logger.js";
import { errorHandler, notFound } from "#src/middleware/errorHandler.js";
import { requestContext } from "#src/middleware/requestContext.js";
import { anonymous, app, as } from "../helpers/app.js";
import { api } from "../helpers/http.js";
import { HANG, clerkEmails, emailLookups } from "../helpers/clerkMock.js";
import { resetDb } from "../helpers/db.js";

const STARTING_BALANCE = 30_000_000;

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("authentication", () => {
  it.each([
    ["no header", undefined],
    ["wrong scheme", "Basic dGVzdDp0ZXN0"],
    ["empty bearer", "Bearer "],
    ["garbage token", "Bearer not-a-real-token"],
    ["bearer with nothing after the prefix", "Bearer test:"],
  ])("answers 401 with the standard error shape: %s", async (_label, header) => {
    const req = anonymous().get("/api/credits");
    if (header !== undefined) req.set("Authorization", header);
    const res = await req;

    expect(res.status).toBe(401);
    expect(ErrorResponseSchema.parse(res.body)).toMatchObject({ code: "UNAUTHORIZED" });
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(res.headers["x-trace-id"]).toBeDefined();
  });

  it("creates no user for a rejected request", async () => {
    await anonymous().get("/api/credits").set("Authorization", "Bearer garbage");
    expect(await prisma.user.count()).toBe(0);
  });

  it("does not reveal which routes exist to someone who is not signed in", async () => {
    const res = await anonymous().get("/api/definitely-not-a-route");
    expect(res.status).toBe(401);
  });

  it("rejects before reading the body: a huge unauthenticated upload is never parsed (no 413) and the client is cut off", async () => {
    const huge = JSON.stringify({ pad: "x".repeat(1_100_000) });
    const outcome = await anonymous()
      .post("/api/credits")
      .set("Content-Type", "application/json")
      .send(huge)
      .then(
        (res) => res.status,
        (error: NodeJS.ErrnoException) => error.code, // the server stops reading, so the client's write may break first
      );
    expect(outcome).not.toBe(413);
    expect([401, "EPIPE", "ECONNRESET"]).toContain(outcome);
  });

  it("still gives an ordinary message from a client with an expired token a clean 401, not a reset", async () => {
    const message = JSON.stringify({ content: "x".repeat(30_000) });
    const res = await anonymous().post("/api/credits").set("Authorization", "Bearer expired").set("Content-Type", "application/json").send(message);
    expect(res.status).toBe(401);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("UNAUTHORIZED");
  });
});

describe("unknown routes", () => {
  it("answers 404 in the standard shape for a signed-in user", async () => {
    const res = await as("u1").get("/api/nope");
    expect(res.status).toBe(404);
    expect(ErrorResponseSchema.parse(res.body)).toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers 404 outside /api without needing credentials", async () => {
    const res = await anonymous().get("/nope");
    expect(res.status).toBe(404);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("NOT_FOUND");
  });

  it("does not support methods a route does not define", async () => {
    expect((await as("u1").post("/api/credits")).status).toBe(404);
  });
});

describe("GET /api/credits and first sign-in", () => {
  it("gives a new user the starting balance, recorded once in the ledger", async () => {
    const res = await as("u1").get("/api/credits");
    expect(res.status).toBe(200);
    expect(CreditsResponseSchema.parse(res.body)).toEqual({ balance: STARTING_BALANCE, held: 0 });

    const ledger = await prisma.creditLedger.findMany({ where: { userId: "u1" } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: "GRANT", amount: STARTING_BALANCE, idempotencyKey: "grant:signup:u1" });
  });

  it("does not grant again on later requests", async () => {
    await as("u1").get("/api/credits");
    await as("u1").get("/api/credits");
    await as("u1").get("/api/credits");
    expect(await prisma.creditLedger.count()).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });

  it("keeps users' balances separate", async () => {
    await as("a").get("/api/credits");
    await as("b").get("/api/credits");
    expect(await prisma.user.count()).toBe(2);
    expect(await prisma.creditLedger.count()).toBe(2);
  });

  it("reports what is held", async () => {
    await as("u1").get("/api/credits");
    await prisma.user.update({ where: { id: "u1" }, data: { held: 100_000 } });
    expect((await as("u1").get("/api/credits")).body).toEqual({ balance: STARTING_BALANCE, held: 100_000 });
  });

  it("is never cached, and carries the security and trace headers", async () => {
    const res = await as("u1").get("/api/credits");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-trace-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("echoes a caller's trace id on success and on errors", async () => {
    const ok = await as("u1").get("/api/credits").set("x-trace-id", "trace-from-client-1");
    const bad = await anonymous().get("/api/credits").set("x-trace-id", "trace-from-client-2");
    expect(ok.headers["x-trace-id"]).toBe("trace-from-client-1");
    expect(bad.headers["x-trace-id"]).toBe("trace-from-client-2");
  });
});

describe("concurrent first sign-ins", () => {
  it("creates exactly one user and one grant when ten requests arrive at once", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => as("racer").get("/api/credits")));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.creditLedger.count()).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "racer" } })).balance).toBe(STARTING_BALANCE);
  });

  it("looks the email up once for those ten requests", async () => {
    await Promise.all(Array.from({ length: 10 }, () => as("racer").get("/api/credits")));
    expect(emailLookups).toEqual(["racer"]);
  });

  it("still creates one user and one grant when another instance races us (empty cache, same database)", async () => {
    await Promise.all(Array.from({ length: 5 }, () => as("racer").get("/api/credits")));
    clearUserCache(); // as if a second server process, which has never seen this user, handled the next burst
    await Promise.all(Array.from({ length: 5 }, () => as("racer").get("/api/credits")));
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.creditLedger.count()).toBe(1);
  });

  it("survives losing the create race to another instance without granting twice", async () => {
    await as("racer").get("/api/credits"); // the "other instance" already created the user and granted
    clearUserCache();
    // our instance checked a moment earlier and saw nothing, so it tries to create
    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(null);
    await expect(ensureUser("racer")).resolves.toBeUndefined();
    expect(await prisma.creditLedger.count()).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "racer" } })).balance).toBe(STARTING_BALANCE);
  });

  it("lets a failed first attempt be retried instead of caching the failure", async () => {
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("database blip"));
    expect((await as("u1").get("/api/credits")).status).toBe(500);
    expect((await as("u1").get("/api/credits")).status).toBe(200);
    expect(await prisma.creditLedger.count()).toBe(1);
  });
});

describe("the user's email", () => {
  it("is stored when Clerk has one", async () => {
    clerkEmails.set("u1", "ada@example.com");
    await as("u1").get("/api/credits");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "u1" } })).email).toBe("ada@example.com");
  });

  it("is left empty, and sign-in still works, when Clerk cannot be reached", async () => {
    clerkEmails.set("u1", new Error("Clerk is down"));
    const res = await as("u1").get("/api/credits");
    expect(res.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "u1" } })).email).toBeNull();
    expect(await prisma.creditLedger.count()).toBe(1);
  });

  it("is left empty, and sign-in still works, when Clerk never answers", async () => {
    clerkEmails.set("u1", HANG);
    const started = Date.now();
    const res = await as("u1").get("/api/credits");
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(6_000);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "u1" } })).email).toBeNull();
  }, 15_000);

  it("is allowed to be shared: a Clerk user re-created with the same email must still be able to sign in", async () => {
    clerkEmails.set("old-id", "same@example.com");
    clerkEmails.set("new-id", "same@example.com");
    expect((await as("old-id").get("/api/credits")).status).toBe(200);
    expect((await as("new-id").get("/api/credits")).status).toBe(200);
    expect(await prisma.user.count({ where: { email: "same@example.com" } })).toBe(2);
  });

  it("is looked up only when the user is created, not on later requests", async () => {
    await as("u1").get("/api/credits");
    await as("u1").get("/api/credits");
    expect(emailLookups).toEqual(["u1"]);
  });
});

describe("the known-user cache", () => {
  it("does not hit the database for a user it already knows", async () => {
    await as("u1").get("/api/credits");
    const spy = vi.spyOn(prisma.user, "findUnique");
    await ensureUser("u1");
    expect(spy).not.toHaveBeenCalled();
  });

  it("recovers when the user's row was deleted behind our back (stale cache)", async () => {
    await as("u1").get("/api/credits");
    await prisma.user.delete({ where: { id: "u1" } });
    const res = await as("u1").get("/api/credits");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ balance: STARTING_BALANCE, held: 0 });
    expect(await prisma.user.count()).toBe(1);
  });

  it("re-checks the database after its entries expire", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await ensureUser("u1");
    await prisma.user.delete({ where: { id: "u1" } });
    await ensureUser("u1");
    expect(await prisma.user.count()).toBe(0); // still trusted: nothing re-created yet

    vi.setSystemTime(Date.now() + 6 * 60_000);
    await ensureUser("u1");
    expect(await prisma.user.count()).toBe(1);
  });
});

describe("request bodies", () => {
  const json = (body: string) => as("u1").post("/api/credits").set("Content-Type", "application/json").send(body);

  it("rejects malformed JSON with 400", async () => {
    const res = await json("{ not json");
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body)).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it.each(["123", '"text"', "null", "true"])("rejects a JSON body that is not an object or array: %s", async (body) => {
    expect((await json(body)).status).toBe(400);
  });

  it("rejects a body over 1 MB with 413", async () => {
    const res = await json(JSON.stringify({ pad: "x".repeat(1_100_000) }));
    expect(res.status).toBe(413);
    expect(ErrorResponseSchema.parse(res.body)).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("accepts a body just under the limit (then finds no such route)", async () => {
    expect((await json(JSON.stringify({ pad: "x".repeat(900_000) }))).status).toBe(404);
  });

  it("does not leak a parser's message or stack", async () => {
    const res = await json("{ not json");
    expect(JSON.stringify(res.body)).not.toMatch(/Unexpected token|SyntaxError|at .*\.js/);
  });

  it("ignores a body sent with another content type", async () => {
    const res = await as("u1").post("/api/credits").set("Content-Type", "text/plain").send("hello");
    expect(res.status).toBe(404);
  });
});

describe("CORS", () => {
  const origin = "http://localhost:3001";

  it("answers a preflight for the frontend with 204, without credentials and without counting against limits", async () => {
    const res = await api(app)
      .options("/api/chats")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "PATCH")
      .set("Access-Control-Request-Headers", "authorization,content-type");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    expect(res.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(res.headers["access-control-allow-headers"]).toMatch(/authorization/i);
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers["access-control-max-age"]).toBe("600");
  });

  it("never echoes a foreign origin back", async () => {
    for (const foreign of ["http://evil.example", "http://localhost:3001.evil.example", "http://localhost:3002", "null"]) {
      const res = await api(app).options("/api/credits").set("Origin", foreign).set("Access-Control-Request-Method", "GET");
      expect(res.headers["access-control-allow-origin"]).not.toBe(foreign);
      expect(res.headers["access-control-allow-origin"]).toBe(origin); // the browser compares this and blocks the page
    }
  });

  it("does not treat a trailing slash as the same origin", async () => {
    const res = await api(app).get("/api/health").set("Origin", `${origin}/`);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    expect(res.headers["access-control-allow-origin"]).not.toBe(`${origin}/`);
  });

  it("lets the browser read the trace id and the rate-limit headers", async () => {
    const res = await as("u1").get("/api/credits").set("Origin", origin);
    const exposed = res.headers["access-control-expose-headers"];
    expect(exposed).toMatch(/X-Trace-Id/i);
    expect(exposed).toMatch(/Retry-After/i);
  });

  it("varies on Origin so caches never mix responses", async () => {
    expect((await api(app).get("/api/health").set("Origin", origin)).headers.vary).toMatch(/Origin/i);
  });
});

describe("GET /api/health", () => {
  it("reports ok with no credentials", async () => {
    const res = await anonymous().get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", db: "up", version: expect.stringMatching(/^\d+\.\d+\.\d+/) as unknown });
    expect(new Date((res.body as { timestamp: string }).timestamp).getTime()).toBeGreaterThan(0);
  });

  it("is never rate limited", async () => {
    const results = await Promise.all(Array.from({ length: 150 }, () => anonymous().get("/api/health")));
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it("creates no users and writes nothing", async () => {
    await anonymous().get("/api/health");
    expect(await prisma.user.count()).toBe(0);
  });

  it("answers 503 when the database is down, without revealing why", async () => {
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"));
    const res = await anonymous().get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "degraded", db: "down" });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
  });

  it("answers 503 within a couple of seconds when the database hangs", async () => {
    vi.spyOn(prisma, "$queryRaw").mockReturnValue(new Promise<never>(() => {}) as never);
    const started = Date.now();
    const res = await anonymous().get("/api/health");
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 10_000);

  it("stays healthy under concurrent checks", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => anonymous().get("/api/health")));
    expect(results.every((r) => (r.body as { status: string }).status === "ok")).toBe(true);
  });
});

describe("the error handler in isolation", () => {
  function appThatFails() {
    const isolated = express();
    isolated.use(requestContext());
    isolated.get("/throws", () => {
      throw new Error("db password=hunter2 at /srv/app/secret.ts");
    });
    isolated.get("/rejects", async () => {
      await Promise.resolve();
      throw new Error("async failure password=hunter2");
    });
    isolated.get("/throws-string", () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "boom";
    });
    isolated.get("/half-sent", (_req, res) => {
      res.write("partial");
      throw new Error("failed after the response started");
    });
    isolated.use(notFound, errorHandler);
    return isolated;
  }

  it.each(["/throws", "/rejects", "/throws-string"])("answers 500 with a generic message and no internals: %s", async (path) => {
    const res = await api(appThatFails()).get(path);
    expect(res.status).toBe(500);
    expect(ErrorResponseSchema.parse(res.body)).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|secret\.ts|stack|boom|Error:/);
    expect(res.headers["x-trace-id"]).toBeDefined();
  });

  it("does not crash or hang when the response had already started", async () => {
    const isolated = appThatFails();
    await api(isolated).get("/half-sent").then(() => undefined, () => undefined);
    expect((await api(isolated).get("/nope")).status).toBe(404); // and keeps serving afterwards
  });
});

describe("when the database is unavailable", () => {
  it("answers 503 (retryable) instead of 500, and recovers as soon as the database does", async () => {
    const outage = new Prisma.PrismaClientKnownRequestError("", { code: "ECONNREFUSED", clientVersion: "7.10.0" });
    vi.spyOn(prisma.user, "findUnique").mockRejectedValueOnce(outage);

    const down = await as("u1").get("/api/credits");
    expect(down.status).toBe(503);
    expect(ErrorResponseSchema.parse(down.body)).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(JSON.stringify(down.body)).not.toMatch(/ECONNREFUSED|prisma/i);

    expect((await as("u1").get("/api/credits")).status).toBe(200); // nothing was cached about the failure
  });
});

describe("the access log", () => {
  function loggedApp() {
    const lines: Record<string, unknown>[] = [];
    const log = createLogger("info", { write: (chunk: string) => void lines.push(JSON.parse(chunk) as Record<string, unknown>) });
    return { app: createApp({ log }), lines };
  }

  it("names the signed-in user and carries the same trace id the client received", async () => {
    const { app: logged, lines } = loggedApp();
    const res = await api(logged).get("/api/credits").set("Authorization", "Bearer test:u1");
    expect(lines.find((l) => l.msg === "request")).toMatchObject({
      userId: "u1",
      traceId: res.headers["x-trace-id"],
      method: "GET",
      path: "/api/credits",
      status: 200,
    });
  });

  it("has no user for a request that was not signed in", async () => {
    const { app: logged, lines } = loggedApp();
    await api(logged).get("/api/credits");
    const line = lines.find((l) => l.msg === "request");
    expect(line).toMatchObject({ status: 401 });
    expect(line).not.toHaveProperty("userId");
  });

  it("never contains the bearer token", async () => {
    const { app: logged, lines } = loggedApp();
    await api(logged).get("/api/credits").set("Authorization", "Bearer test:u1");
    const text = JSON.stringify(lines);
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("test:u1"); // the token itself (the user id is logged as "u1")
    expect(JSON.stringify(lines)).not.toContain("authorization");
  });
});

describe("rate limiting in the full app", () => {
  const limited = () => createApp({ rateLimits: { authenticated: 3, anonymous: 2, windowMs: 60_000 } });

  it("limits each signed-in user separately and answers 429 in the standard shape", async () => {
    const tight = limited();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await api(tight).get("/api/credits").set("Authorization", "Bearer test:u1")).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);

    const blocked = await api(tight).get("/api/credits").set("Authorization", "Bearer test:u1");
    expect(ErrorResponseSchema.parse(blocked.body)).toMatchObject({ code: "RATE_LIMITED" });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await api(tight).get("/api/credits").set("Authorization", "Bearer test:u2")).status).toBe(200);
  });

  it("counts requests with no valid session per IP, at the lower allowance, before any database work", async () => {
    const tight = limited();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await api(tight).get("/api/credits")).status);
    expect(codes).toEqual([401, 401, 429, 429]);
    expect(await prisma.user.count()).toBe(0);
  });

  it("never limits the health check", async () => {
    const tight = limited();
    const codes = await Promise.all(Array.from({ length: 20 }, () => api(tight).get("/api/health").then((r) => r.status)));
    expect(codes.every((code) => code === 200)).toBe(true);
  });

  it("lets a CORS preflight through without counting it", async () => {
    const tight = limited();
    for (let i = 0; i < 10; i++) {
      const res = await api(tight).options("/api/credits").set("Origin", "http://localhost:3001").set("Access-Control-Request-Method", "GET");
      expect(res.status).toBe(204);
    }
    expect((await api(tight).get("/api/credits")).status).toBe(401); // the anonymous allowance is untouched
  });
});
