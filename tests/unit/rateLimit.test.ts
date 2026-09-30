import express from "express";
import { describe, expect, it } from "vitest";
import { api } from "../helpers/http.js";
import { clerkAuth } from "#src/auth/clerk.js";
import { ErrorResponseSchema } from "#src/contracts/index.js";
import { errorHandler } from "#src/middleware/errorHandler.js";
import { createApiRateLimit, createMessageSendRateLimit } from "#src/middleware/rateLimit.js";

// clerkAuth here is the test double: "Bearer test:<id>" is a signed-in user, anything else is anonymous.
function appWith(limiter: express.RequestHandler) {
  const app = express();
  app.use(clerkAuth(), limiter);
  app.get("/ping", (_req, res) => void res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

const as = (app: express.Express, user: string) => api(app).get("/ping").set("Authorization", `Bearer test:${user}`);
const statuses = async (n: number, send: () => Promise<{ status: number }>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await send()).status);
  return out;
};

describe("createApiRateLimit", () => {
  it("lets a signed-in user through up to the limit, then answers 429 in the standard error shape", async () => {
    const app = appWith(createApiRateLimit({ authenticated: 3, anonymous: 1 }));
    expect(await statuses(5, () => as(app, "u1"))).toEqual([200, 200, 200, 429, 429]);

    const limited = await as(app, "u1");
    expect(limited.status).toBe(429);
    expect(ErrorResponseSchema.parse(limited.body)).toMatchObject({ code: "RATE_LIMITED" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.headers["ratelimit"]).toBeDefined();
    expect(limited.headers["ratelimit-policy"]).toBeDefined();
  });

  it("counts each user separately, so one noisy user cannot lock out another", async () => {
    const app = appWith(createApiRateLimit({ authenticated: 2, anonymous: 1 }));
    await statuses(3, () => as(app, "noisy"));
    expect((await as(app, "quiet")).status).toBe(200);
  });

  it("counts a user across all their connections (one key per user, not per IP or per tab)", async () => {
    const app = appWith(createApiRateLimit({ authenticated: 2, anonymous: 1 }));
    const results = await Promise.all([1, 2, 3].map(() => as(app, "same-user").set("X-Forwarded-For", "203.0.113.9")));
    expect(results.filter((r) => r.status === 429)).toHaveLength(1);
  });

  it("gives anonymous callers the lower allowance, keyed by IP", async () => {
    const app = appWith(createApiRateLimit({ authenticated: 50, anonymous: 2 }));
    expect(await statuses(3, () => api(app).get("/ping"))).toEqual([200, 200, 429]);
  });

  it("keeps anonymous and signed-in counters independent", async () => {
    const app = appWith(createApiRateLimit({ authenticated: 2, anonymous: 1 }));
    await statuses(2, () => api(app).get("/ping"));
    expect((await as(app, "u1")).status).toBe(200);
  });

  it("does not let a garbage token count as a user (it is anonymous, with the lower limit)", async () => {
    const app = appWith(createApiRateLimit({ authenticated: 50, anonymous: 1 }));
    const bad = () => api(app).get("/ping").set("Authorization", "Bearer not-a-real-token");
    expect(await statuses(2, bad)).toEqual([200, 429]);
  });

  it("starts a fresh window after windowMs", async () => {
    const app = appWith(createApiRateLimit({ authenticated: 1, anonymous: 1, windowMs: 250 }));
    expect(await statuses(2, () => as(app, "u1"))).toEqual([200, 429]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await as(app, "u1")).status).toBe(200);
  });

  it("gives every instance its own counters", async () => {
    const a = appWith(createApiRateLimit({ authenticated: 1 }));
    const b = appWith(createApiRateLimit({ authenticated: 1 }));
    await statuses(2, () => as(a, "u1"));
    expect((await as(b, "u1")).status).toBe(200);
  });
});

describe("createMessageSendRateLimit", () => {
  it("has its own small per-user allowance", async () => {
    const app = appWith(createMessageSendRateLimit({ limit: 2 }));
    expect(await statuses(3, () => as(app, "u1"))).toEqual([200, 200, 429]);
    expect((await as(app, "u2")).status).toBe(200);
  });

  it("is independent of the general limiter", async () => {
    const general = createApiRateLimit({ authenticated: 100 });
    const sends = createMessageSendRateLimit({ limit: 1 });
    const app = express();
    app.use(clerkAuth(), general);
    app.get("/ping", (_req, res) => void res.json({ ok: true }));
    app.post("/send", sends, (_req, res) => void res.json({ ok: true }));
    app.use(errorHandler);
    const post = () => api(app).post("/send").set("Authorization", "Bearer test:u1");

    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
    expect((await as(app, "u1")).status).toBe(200); // other routes are unaffected
  });

  it("defaults to 10 per minute", async () => {
    const app = appWith(createMessageSendRateLimit());
    const codes = await statuses(11, () => as(app, "u1"));
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});
