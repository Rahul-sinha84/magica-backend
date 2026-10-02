import { beforeEach, describe, expect, it } from "vitest";
import { ApiKeyListResponseSchema, ApiKeyResponseSchema, CreateApiKeyResponseSchema, ErrorResponseSchema, MAX_ACTIVE_API_KEYS } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { createApp } from "#src/app.js";
import { createLogger } from "#src/lib/logger.js";
import { API_KEY_PATTERN, generateApiKey, hashApiKey } from "#src/lib/apiKeys.js";
import { findWorkingApiKey } from "#src/services/apiKeys.js";
import { anonymous, as } from "../helpers/app.js";
import { fixtures, resetDb } from "../helpers/db.js";
import { api } from "../helpers/http.js";

beforeEach(async () => {
  await resetDb();
  await fixtures.user({ id: "u1" });
  await fixtures.user({ id: "u2" });
});

async function create(userId: string, body: Record<string, unknown>) {
  const res = await as(userId).post("/api/api-keys").send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return CreateApiKeyResponseSchema.parse(res.body);
}
const list = async (userId: string) => ApiKeyListResponseSchema.parse((await as(userId).get("/api/api-keys")).body);
const HOUR = 3_600_000;

describe("creating a key", () => {
  it("returns the key once, with its defaults, and stores only its hash", async () => {
    const { apiKey, secret } = await create("u1", { label: "  My server  " });
    expect(secret).toMatch(API_KEY_PATTERN);
    expect(apiKey).toMatchObject({ label: "My server", prefix: secret.slice(0, 12), perMinute: 60, perDay: 1000, status: "active", expiresAt: null, lastUsedAt: null });

    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: apiKey.id } });
    expect(row.hash).toBe(hashApiKey(secret));
    expect(JSON.stringify(row)).not.toContain(secret.slice(12)); // the secret part is nowhere in the row
    expect(JSON.stringify(await list("u1"))).not.toContain(secret.slice(12)); // nor ever shown again
  });

  it("never writes the key to the logs", async () => {
    const lines: string[] = [];
    const log = createLogger("debug", { write: (line: string) => void lines.push(line) });
    const app = createApp({ log, rateLimits: { authenticated: 1_000_000, anonymous: 1_000_000 } });
    const res = await api(app).post("/api/api-keys").set("Authorization", "Bearer test:u1").send({ label: "Logged?" });
    expect(res.status).toBe(201);
    const { secret } = CreateApiKeyResponseSchema.parse(res.body);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(secret.slice(12));
  });

  it("takes limits and an expiry, within the allowed ranges", async () => {
    const expiresAt = new Date(Date.now() + 24 * HOUR).toISOString();
    const { apiKey } = await create("u1", { label: "Batch job", perMinute: 10_000, perDay: 1, expiresAt });
    expect(apiKey).toMatchObject({ perMinute: 10_000, perDay: 1, expiresAt });
  });

  it.each([
    ["no name", { label: "   " }, "label: Give the key a name."],
    ["a name over 64 characters", { label: "x".repeat(65) }, "label: A key's name can be at most 64 characters."],
    ["0 per minute", { label: "k", perMinute: 0 }, undefined],
    ["over 10,000 per minute", { label: "k", perMinute: 10_001 }, undefined],
    ["over 100,000 per day", { label: "k", perDay: 100_001 }, undefined],
    ["a fractional limit", { label: "k", perDay: 1.5 }, undefined],
    ["an expiry in the past", { label: "k", expiresAt: new Date(Date.now() - 1000).toISOString() }, "expiresAt: Choose a time in the future."],
    ["an expiry that isn't a date", { label: "k", expiresAt: "tomorrow" }, undefined],
    ["an unknown field", { label: "k", hash: "0".repeat(64) }, undefined],
  ])("refuses %s", async (_label, body, message) => {
    const res = await as("u1").post("/api/api-keys").send(body);
    expect(res.status).toBe(400);
    const error = ErrorResponseSchema.parse(res.body);
    expect(error.code).toBe("VALIDATION_FAILED");
    if (message) expect(error.error).toBe(message);
    expect(await prisma.apiKey.count()).toBe(0);
  });

  it(`allows at most ${MAX_ACTIVE_API_KEYS} active keys; revoked and expired ones don't count`, async () => {
    for (let i = 0; i < MAX_ACTIVE_API_KEYS; i++) await create("u1", { label: `k${i}` });
    const refused = await as("u1").post("/api/api-keys").send({ label: "eleventh" });
    expect(refused.status).toBe(409);
    expect(ErrorResponseSchema.parse(refused.body)).toEqual({ code: "API_KEY_LIMIT_REACHED", error: "You can have at most 10 active API keys. Revoke one to create another." });
    expect(await create("u2", { label: "another user's" })).toBeTruthy(); // the cap is per user

    const { apiKeys } = await list("u1");
    await as("u1").delete(`/api/api-keys/${apiKeys[0]!.id}`);
    await create("u1", { label: "after a revoke" });
    await prisma.apiKey.updateMany({ where: { userId: "u1", label: "k0" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await create("u1", { label: "after an expiry" });
    expect((await list("u1")).activeCount).toBe(10);
  });

  it("waits for a create already under way, so the count it checks is current (no 11th key)", async () => {
    for (let i = 0; i < MAX_ACTIVE_API_KEYS - 2; i++) await create("u1", { label: `k${i}` });
    let release = () => undefined as void;
    let lockedNow = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const locked = new Promise<void>((resolve) => (lockedNow = resolve));
    // another create of this user's keys, mid-way: it holds the lock and has added keys 9 and 10, not yet committed
    const other = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = 'u1' FOR UPDATE`;
        for (const label of ["ninth", "tenth"]) {
          const { prefix, hash } = generateApiKey();
          await tx.apiKey.create({ data: { userId: "u1", label, prefix, hash } });
        }
        lockedNow();
        await held;
      },
      { timeout: 10_000 },
    );
    await locked;
    const racer = as("u1").post("/api/api-keys").send({ label: "racer" }).then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 300)); // the racer is now waiting for the lock
    release();
    await other;
    const res = await racer;
    expect(res.status).toBe(409);
    expect(await prisma.apiKey.count({ where: { userId: "u1", revokedAt: null } })).toBe(MAX_ACTIVE_API_KEYS);
  });

  it("can't go over the cap when several are created at the same moment", async () => {
    for (let i = 0; i < MAX_ACTIVE_API_KEYS - 2; i++) await create("u1", { label: `k${i}` });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => as("u1").post("/api/api-keys").send({ label: `race${i}` })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409, 409, 409, 409]);
    expect(await prisma.apiKey.count({ where: { userId: "u1", revokedAt: null } })).toBe(MAX_ACTIVE_API_KEYS);
  });
});

describe("listing keys", () => {
  it("lists the user's own keys that aren't revoked, newest first, with the n/10 counter", async () => {
    const first = await create("u1", { label: "first" });
    const second = await create("u1", { label: "second" });
    const gone = await create("u1", { label: "revoked" });
    await create("u2", { label: "not mine" });
    await as("u1").delete(`/api/api-keys/${gone.apiKey.id}`);
    await prisma.apiKey.update({ where: { id: first.apiKey.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const body = await list("u1");
    expect(body.apiKeys.map((k) => [k.label, k.status])).toEqual([
      ["second", "active"],
      ["first", "expired"],
    ]);
    expect(body).toMatchObject({ activeCount: 1, maxActive: 10 });
    expect(body.apiKeys[0]).not.toHaveProperty("hash");
    expect(second.apiKey.id).toBe(body.apiKeys[0]!.id);
  });
});

describe("changing a key", () => {
  it("renames it and changes its limits", async () => {
    const { apiKey } = await create("u1", { label: "old" });
    const res = await as("u1").patch(`/api/api-keys/${apiKey.id}`).send({ label: " new ", perMinute: 5 });
    expect(res.status).toBe(200);
    expect(ApiKeyResponseSchema.parse(res.body).apiKey).toMatchObject({ id: apiKey.id, label: "new", perMinute: 5, perDay: 1000 });
  });

  it.each([
    ["nothing to change", {}],
    ["a blank name", { label: " " }],
    ["limits out of range", { perDay: 0 }],
    ["the key itself", { prefix: "mgc_hacked00" }],
  ])("refuses %s", async (_label, body) => {
    const { apiKey } = await create("u1", { label: "k" });
    expect((await as("u1").patch(`/api/api-keys/${apiKey.id}`).send(body)).status).toBe(400);
  });

  it("can't change a revoked key, or another user's (404, nothing changes)", async () => {
    const { apiKey } = await create("u1", { label: "k" });
    expect((await as("u2").patch(`/api/api-keys/${apiKey.id}`).send({ label: "mine now" })).status).toBe(404);
    await as("u1").delete(`/api/api-keys/${apiKey.id}`);
    expect((await as("u1").patch(`/api/api-keys/${apiKey.id}`).send({ label: "back?" })).status).toBe(404);
    expect(await prisma.apiKey.findUniqueOrThrow({ where: { id: apiKey.id } })).toMatchObject({ label: "k" });
  });
});

describe("revoking a key", () => {
  it("stops it working for good; revoking again is harmless", async () => {
    const { apiKey, secret } = await create("u1", { label: "k" });
    expect(await findWorkingApiKey(secret)).toMatchObject({ id: apiKey.id, userId: "u1" });
    expect((await as("u1").delete(`/api/api-keys/${apiKey.id}`)).status).toBe(204);
    expect(await findWorkingApiKey(secret)).toBeNull();
    expect((await as("u1").delete(`/api/api-keys/${apiKey.id}`)).status).toBe(204);
    expect(await prisma.apiKey.findUniqueOrThrow({ where: { id: apiKey.id } })).toMatchObject({ revokedAt: expect.any(Date) as unknown });
  });

  it("is the owner's alone", async () => {
    const { apiKey, secret } = await create("u1", { label: "k" });
    expect((await as("u2").delete(`/api/api-keys/${apiKey.id}`)).status).toBe(404);
    expect(await findWorkingApiKey(secret)).not.toBeNull();
  });

  it("answers 404 for an id that doesn't exist or isn't an id, and 401 without a session", async () => {
    expect((await as("u1").delete("/api/api-keys/cmnotakey00000000000000")).status).toBe(404);
    expect((await as("u1").delete("/api/api-keys/not an id!")).status).toBe(404);
    expect((await anonymous().get("/api/api-keys")).status).toBe(401);
    expect((await anonymous().post("/api/api-keys").send({ label: "k" })).status).toBe(401);
  });
});

describe("checking a presented key", () => {
  it("works only for the exact key, by its hash, while it's active", async () => {
    const { apiKey, secret } = await create("u1", { label: "k", expiresAt: new Date(Date.now() + HOUR).toISOString() });
    expect((await findWorkingApiKey(secret))?.id).toBe(apiKey.id);
    const altered = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
    expect(await findWorkingApiKey(altered)).toBeNull();
    expect(await findWorkingApiKey(secret.toUpperCase())).toBeNull();
    expect(await findWorkingApiKey(`gx_${secret.slice(4)}`)).toBeNull();
    expect(await findWorkingApiKey("")).toBeNull();
    expect(await findWorkingApiKey(secret, new Date(Date.now() + 2 * HOUR))).toBeNull(); // after its expiry
  });
});

describe("the ApiKey table", () => {
  const row = (overrides: Record<string, unknown>) => ({ userId: "u1", label: "k", prefix: "mgc_abcdefgh", hash: "a".repeat(64), ...overrides });
  it.each([
    ["a limit out of range", { perMinute: 0 }],
    ["an empty label", { label: "" }],
    ["a hash that isn't sha256 hex", { hash: "not-a-hash" }],
    ["a prefix that isn't ours", { prefix: "gx_abcdefgh" }],
  ])("refuses %s", async (_label, overrides) => {
    await expect(prisma.apiKey.create({ data: row(overrides) })).rejects.toThrow();
  });

  it("refuses the same hash twice, and goes with its user", async () => {
    await prisma.apiKey.create({ data: row({}) });
    await expect(prisma.apiKey.create({ data: row({}) })).rejects.toThrow();
    await prisma.user.delete({ where: { id: "u1" } });
    expect(await prisma.apiKey.count()).toBe(0);
  });
});
