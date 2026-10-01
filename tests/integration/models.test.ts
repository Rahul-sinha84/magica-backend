import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsResponseSchema } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { getModels, HEALTH_CACHE_MS, HEALTH_WINDOW_MS, resetModelsCache } from "#src/services/models.js";
import { anonymous, as } from "../helpers/app.js";
import { fixtures, resetDb } from "../helpers/db.js";

beforeEach(async () => {
  await resetDb();
  resetModelsCache();
});

async function ended(status: "COMPLETED" | "FAILED" | "CANCELLED", { errorCode = null as string | null, model = null as string | null, agoMs = 1_000 } = {}) {
  const user = await fixtures.user();
  const chat = await fixtures.chat(user.id);
  const run = await fixtures.run(chat.id, user.id, status);
  await prisma.agentRun.update({ where: { id: run.id }, data: { completedAt: new Date(Date.now() - agoMs), errorCode, model } });
}

const models = async () => {
  const res = await as("viewer").get("/api/models");
  expect(res.status).toBe(200);
  return ModelsResponseSchema.parse(res.body);
};

describe("GET /api/models", () => {
  it("needs a signed-in user", async () => {
    expect((await anonymous().get("/api/models")).status).toBe(401);
  });

  it("lists only the free router, as the default, with no recent turns to judge by", async () => {
    const body = await models();
    expect(body.models).toEqual([{ id: "openrouter/free", name: "OpenRouter Free", provider: "openrouter", free: true, isDefault: true }]);
    expect(body.defaultModelId).toBe("openrouter/free");
    expect(body.status).toMatchObject({ health: "unknown", lastRoutedModel: null });
    expect(Date.parse(body.status.checkedAt)).toBeGreaterThan(Date.now() - 10_000);
  });

  it("reports the model is answering, and which real model the router used last", async () => {
    await ended("COMPLETED", { model: "older/free", agoMs: 60_000 });
    await ended("COMPLETED", { model: "meta/free-7b" });
    expect((await models()).status).toMatchObject({ health: "available", lastRoutedModel: "meta/free-7b" });
  });

  it("reports degraded, then unavailable, as model failures pile up", async () => {
    await ended("COMPLETED", { model: "meta/free-7b", agoMs: 60_000 });
    await ended("FAILED", { errorCode: "MODEL_RATE_LIMITED", agoMs: 30_000 });
    expect((await models()).status.health).toBe("degraded");

    resetModelsCache();
    await ended("FAILED", { errorCode: "MODEL_UNAVAILABLE", agoMs: 20_000 });
    await ended("FAILED", { errorCode: "MODEL_RATE_LIMITED", agoMs: 10_000 });
    expect((await models()).status).toMatchObject({ health: "unavailable", lastRoutedModel: "meta/free-7b" });
  });

  it("ignores turns that ended too long ago, cancelled turns, and failures that are not the model's", async () => {
    await ended("FAILED", { errorCode: "MODEL_RATE_LIMITED", agoMs: HEALTH_WINDOW_MS + 60_000 });
    await ended("CANCELLED");
    await ended("FAILED", { errorCode: "AGENT_CRASHED" });
    expect((await models()).status.health).toBe("unknown");
  });

  it("answers from a short cache, so polling it costs one query per process every 30 seconds", async () => {
    await ended("COMPLETED", { model: "meta/free-7b" });
    const spy = vi.spyOn(prisma.agentRun, "findMany");
    const now = Date.now();
    expect((await getModels(now)).status.health).toBe("available");
    await ended("FAILED", { errorCode: "MODEL_RATE_LIMITED" });
    await ended("FAILED", { errorCode: "MODEL_RATE_LIMITED" });
    await ended("FAILED", { errorCode: "MODEL_RATE_LIMITED" });
    expect((await getModels(now + HEALTH_CACHE_MS - 1)).status.health).toBe("available"); // still cached
    expect((await getModels(now + HEALTH_CACHE_MS)).status.health).toBe("unavailable"); // refreshed
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("shares one query between callers that ask at the same moment", async () => {
    const spy = vi.spyOn(prisma.agentRun, "findMany");
    await Promise.all(Array.from({ length: 10 }, () => getModels()));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("tries again on the next call after a failed query, instead of caching the failure", async () => {
    const spy = vi.spyOn(prisma.agentRun, "findMany").mockRejectedValueOnce(new Error("database blip"));
    await expect(getModels()).rejects.toThrow("database blip");
    expect((await getModels()).status.health).toBe("unknown");
    spy.mockRestore();
  });

  it("reads recent turns through the completion-time index, with no table scan or sort", async () => {
    await ended("COMPLETED", { model: "meta/free-7b" });
    const plan = await prisma.$transaction(async (tx) => {
      for (const knob of ["enable_seqscan", "enable_bitmapscan", "enable_sort"]) await tx.$executeRawUnsafe(`SET LOCAL ${knob} = off`);
      const rows = await tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN SELECT status, "errorCode", model FROM "AgentRun" WHERE status IN ('COMPLETED', 'FAILED') AND "completedAt" >= now() - interval '15 minutes' ORDER BY "completedAt" DESC LIMIT 20`,
      );
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("AgentRun_completedAt_idx");
    expect(plan).not.toMatch(/\bSort\b/);
    expect(plan).not.toContain("Seq Scan");
  });
});
