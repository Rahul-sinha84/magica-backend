import type { ModelHealth, ModelsResponse } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { env } from "#src/env/base.js";

// Only recent turns say anything about how the free model is doing now.
export const HEALTH_WINDOW_MS = 15 * 60_000;
const SAMPLE = 20;
// The most recent turns that judged the model; all of them failing because of it means it is down.
const UNAVAILABLE_AFTER = 3;
// One small indexed query per process per this long, however many clients ask.
export const HEALTH_CACHE_MS = 30_000;

// The failure codes that are the model's doing (see FAILURE_INFO in lib/openrouter.ts). A cancel, a crash of our own
// or an interrupted stream says nothing about whether the model is answering.
export const MODEL_FAILURE_CODES: readonly string[] = ["MODEL_RATE_LIMITED", "MODEL_UNAVAILABLE", "MODEL_EMPTY", "MODEL_CONFIG"];

interface Ended {
  status: string;
  errorCode: string | null;
  model: string | null;
}

/** Pure, so every rule is easy to test: how the model is doing, judged by recently ended turns (newest first). */
export function judgeHealth(recent: readonly Ended[]): { health: ModelHealth; lastRoutedModel: string | null } {
  const lastRoutedModel = recent.find((run) => run.status === "COMPLETED" && run.model)?.model ?? null;
  const modelFailed = (run: Ended) => run.status === "FAILED" && run.errorCode !== null && MODEL_FAILURE_CODES.includes(run.errorCode);
  // a turn says something about the model only if it answered, or failed because of the model
  const judged = recent.filter((run) => run.status === "COMPLETED" || modelFailed(run));
  if (judged.length === 0) return { health: "unknown", lastRoutedModel };
  const latest = judged.slice(0, UNAVAILABLE_AFTER);
  if (latest.length === UNAVAILABLE_AFTER && latest.every(modelFailed)) return { health: "unavailable", lastRoutedModel };
  return { health: judged.some(modelFailed) ? "degraded" : "available", lastRoutedModel };
}

const MODEL_ID = env.OPENROUTER_MODEL;

let cached: { at: number; value: ModelsResponse } | null = null;
let inflight: Promise<ModelsResponse> | null = null;

async function load(now: number): Promise<ModelsResponse> {
  const recent = await prisma.agentRun.findMany({
    where: { status: { in: ["COMPLETED", "FAILED"] }, completedAt: { gte: new Date(now - HEALTH_WINDOW_MS) } },
    orderBy: { completedAt: "desc" },
    take: SAMPLE,
    select: { status: true, errorCode: true, model: true },
  });
  const { health, lastRoutedModel } = judgeHealth(recent);
  return {
    models: [{ id: MODEL_ID, name: "OpenRouter Free", provider: "openrouter", free: true, isDefault: true }],
    defaultModelId: MODEL_ID,
    status: { health, lastRoutedModel, checkedAt: new Date(now).toISOString() },
  };
}

/** The model list with the free model's recent health. Cached briefly, and concurrent callers share one query. */
export async function getModels(now = Date.now()): Promise<ModelsResponse> {
  if (cached && now - cached.at < HEALTH_CACHE_MS) return cached.value;
  inflight ??= load(now)
    .then((value) => {
      cached = { at: now, value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** For tests. */
export function resetModelsCache(): void {
  cached = null;
  inflight = null;
}
