import { z } from "zod";

const key = z.string().trim().min(1);

// Postgres INTEGER is 32-bit; credits are stored as Int, so larger values would overflow at write time.
const INT32_MAX = 2_147_483_647;
const credits = z.coerce.number().int().positive().max(INT32_MAX);

// Needed by every process (API server and Trigger.dev worker).
export const BaseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // The trial forbids paid LLM routes, so anything but the free router is a boot failure in every process.
  OPENROUTER_MODEL: z
    .literal("openrouter/free", { error: 'must be "openrouter/free" (paid models are not allowed)' })
    .default("openrouter/free"),
});

export const ServerEnvSchema = BaseEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Normalised to a bare origin: browsers send `Origin` without a trailing slash or path, so CORS must match exactly.
  // How many reverse proxies sit in front (0 = none). Needed so rate limiting sees the real client IP.
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  FRONTEND_ORIGIN: z
    .url({ protocol: /^https?$/ })
    .transform((u) => new URL(u).origin)
    .default("http://localhost:3001"),
  CLERK_SECRET_KEY: key.startsWith("sk_"),
  CLERK_PUBLISHABLE_KEY: key.startsWith("pk_"),
  TRIGGER_SECRET_KEY: key.startsWith("tr_"),
  CREDIT_STARTING_BALANCE: credits.default(30_000_000),
  CREDIT_ADMISSION_HOLD: credits.default(100_000),
}).refine((e) => e.CREDIT_ADMISSION_HOLD <= e.CREDIT_STARTING_BALANCE, {
  path: ["CREDIT_ADMISSION_HOLD"],
  error: "must not exceed CREDIT_STARTING_BALANCE",
});

export const WorkerEnvSchema = BaseEnvSchema.extend({
  OPENROUTER_API_KEY: key,
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
});

// Values are trimmed; blank ones (e.g. `KEY=` copied from .env.example) count as missing, not as empty strings.
const normalise = (v: string | undefined) => v?.trim() || undefined;

export function parseEnv<T extends z.ZodType>(schema: T, source: Record<string, string | undefined>): z.output<T> {
  const input = Object.fromEntries(Object.entries(source).map(([k, v]) => [k, normalise(v)]));
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
