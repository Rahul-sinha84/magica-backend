import { z } from "zod";

const key = z.string().trim().min(1);

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
  FRONTEND_ORIGIN: z.url().default("http://localhost:3001"),
  CLERK_SECRET_KEY: key.startsWith("sk_"),
  CLERK_PUBLISHABLE_KEY: key.startsWith("pk_"),
  TRIGGER_SECRET_KEY: key.startsWith("tr_"),
  CREDIT_STARTING_BALANCE: z.coerce.number().int().positive().default(30_000_000),
  CREDIT_ADMISSION_HOLD: z.coerce.number().int().positive().default(100_000),
}).refine((e) => e.CREDIT_ADMISSION_HOLD <= e.CREDIT_STARTING_BALANCE, {
  path: ["CREDIT_ADMISSION_HOLD"],
  error: "must not exceed CREDIT_STARTING_BALANCE",
});

export const WorkerEnvSchema = BaseEnvSchema.extend({
  OPENROUTER_API_KEY: key,
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
});

// Blank values (e.g. `KEY=` copied from .env.example) count as missing, not as empty strings.
const blankToUndefined = (v: string | undefined) => (v?.trim() === "" ? undefined : v);

export function parseEnv<T extends z.ZodType>(schema: T, source: Record<string, string | undefined>): z.output<T> {
  const input = Object.fromEntries(Object.entries(source).map(([k, v]) => [k, blankToUndefined(v)]));
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
