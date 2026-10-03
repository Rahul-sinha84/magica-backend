import type { ModelHealth, ModelsResponse } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { env } from "#src/env/base.js";
import { FAILURE_INFO } from "#src/lib/modelFailures.js";

// Only recent turns say anything about how the free model is doing now.
export const HEALTH_WINDOW_MS = 15 * 60_000;
const SAMPLE = 20;
// The most recent turns that judged the model; all of them failing because of it means it is down.
const UNAVAILABLE_AFTER = 3;
// One small indexed query per process per this long, however many clients ask.
export const HEALTH_CACHE_MS = 30_000;

// The failure codes that are the model's doing (see FAILURE_INFO in lib/openrouter.ts). A cancel, a crash of our own
// or an interrupted stream says nothing about whether the model is answering.
export const MODEL_FAILURE_CODES: readonly string[] = ["MODEL_RATE_LIMITED", "MODEL_DAILY_LIMIT", "MODEL_UNAVAILABLE", "MODEL_EMPTY", "MODEL_CONFIG"];

const DAILY_LIMIT = FAILURE_INFO.DAILY_LIMIT;

interface Ended {
  status: string;
  errorCode: string | null;
  model: string | null;
  completedAt?: Date | null;
}

/** When the current UTC day began: the free route's daily allowance resets then. */
const utcDayStart = (now: number) => {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
};

/** Pure, so every rule is easy to test: how the model is doing, judged by recently ended turns (newest first). */
export function judgeHealth(recent: readonly Ended[], now = Date.now()): { health: ModelHealth; lastRoutedModel: string | null; reason: string | null } {
  const lastRoutedModel = recent.find((run) => run.status === "COMPLETED" && run.model)?.model ?? null;
  // a daily-limit failure from before the last reset says nothing about now
  const stale = (run: Ended) => run.errorCode === DAILY_LIMIT.code && !!run.completedAt && run.completedAt.getTime() < utcDayStart(now);
  const modelFailed = (run: Ended) => run.status === "FAILED" && run.errorCode !== null && MODEL_FAILURE_CODES.includes(run.errorCode) && !stale(run);
  // a turn says something about the model only if it answered, or failed because of the model
  const judged = recent.filter((run) => run.status === "COMPLETED" || modelFailed(run));
  if (judged.length === 0) return { health: "unknown", lastRoutedModel, reason: null };
  // the daily allowance belongs to the whole account: once it is used up, every turn fails until it resets
  if (judged[0]?.errorCode === DAILY_LIMIT.code) return { health: "unavailable", lastRoutedModel, reason: DAILY_LIMIT.message };
  const latest = judged.slice(0, UNAVAILABLE_AFTER);
  if (latest.length === UNAVAILABLE_AFTER && latest.every(modelFailed)) return { health: "unavailable", lastRoutedModel, reason: null };
  return { health: judged.some(modelFailed) ? "degraded" : "available", lastRoutedModel, reason: null };
}

const MODEL_ID = env.OPENROUTER_MODEL;

let cached: { at: number; value: ModelsResponse } | null = null;
let inflight: Promise<ModelsResponse> | null = null;

async function load(now: number): Promise<ModelsResponse> {
  const recent = await prisma.agentRun.findMany({
    where: { status: { in: ["COMPLETED", "FAILED"] }, completedAt: { gte: new Date(now - HEALTH_WINDOW_MS) } },
    orderBy: { completedAt: "desc" },
    take: SAMPLE,
    select: { status: true, errorCode: true, model: true, completedAt: true },
  });
  const { health, lastRoutedModel, reason } = judgeHealth(recent, now);
  return {
    models: [{ id: MODEL_ID, name: "OpenRouter Free", provider: "openrouter", free: true, isDefault: true }],
    defaultModelId: MODEL_ID,
    status: { health, lastRoutedModel, reason, checkedAt: new Date(now).toISOString() },
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
