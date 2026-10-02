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
  // Connections per process. Every Trigger.dev run is its own process, so with many turns at once keep this small
  // (1-2) on the worker and put a pooler (PgBouncer, Neon's pooled URL) in front of Postgres.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // Longest a single SQL statement may run. Sent when connecting; some connection poolers reject that, so 0 doesn't
  // send it (set it on the database role instead: ALTER ROLE <role> SET statement_timeout = '15s').
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(15_000),
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
  // Transloadit (Community plan) for direct uploads: the API signs each upload with these, so the secret never reaches
  // the browser. Optional: without them the API still starts and uploads answer "unavailable" (set both, or neither).
  TRANSLOADIT_AUTH_KEY: key.regex(/^\S+$/, { error: "must not contain spaces or line breaks" }).optional(),
  TRANSLOADIT_AUTH_SECRET: key.regex(/^\S+$/, { error: "must not contain spaces or line breaks" }).optional(),
  // This API's own public https address (e.g. the Railway domain). When set, Transloadit is asked to report finished
  // uploads to it directly, so an upload completes even if the browser closes. Unset in development (not reachable).
  PUBLIC_API_URL: z
    .url({ protocol: /^https$/, error: "must be the API's public https address" })
    .transform((u) => new URL(u).origin)
    .optional(),
})
  .refine((e) => !e.TRANSLOADIT_AUTH_KEY === !e.TRANSLOADIT_AUTH_SECRET, {
    path: ["TRANSLOADIT_AUTH_SECRET"],
    error: "set both TRANSLOADIT_AUTH_KEY and TRANSLOADIT_AUTH_SECRET, or neither",
  })
  .refine((e) => e.CREDIT_ADMISSION_HOLD <= e.CREDIT_STARTING_BALANCE, {
    path: ["CREDIT_ADMISSION_HOLD"],
    error: "must not exceed CREDIT_STARTING_BALANCE",
  });

export const WorkerEnvSchema = BaseEnvSchema.extend({
  OPENROUTER_API_KEY: key,
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
  // How many turns run at once; the rest wait in Trigger.dev's queue (and never fail for waiting). The free model's
  // rate limit is the real ceiling, so raising this mostly turns waiting into 429s. Read when the task is indexed.
  AGENT_CONCURRENCY_LIMIT: z.coerce.number().int().min(1).max(1000).default(20),
  // A step whose paid tool calls cost more than this (in credits) waits for the user to approve the spend, unless an
  // approved plan covers it. The default lets a single image (1,000,000) run without asking.
  CREDIT_APPROVAL_THRESHOLD: z.coerce.number().int().min(0).max(1_000_000_000).default(2_000_000),
  // Magica's model API (Crop Image, GPT Image 2, Merge Videos). Only the worker calls it, so only the worker has the
  // key. The base URL is configuration with no default, so no environment's host is ever baked into the code.
  // a pasted key with a space or line break inside would only fail later, as a confusing 401
  MAGICA_API_KEY: key.regex(/^\S+$/, { error: "must not contain spaces or line breaks" }),
  // paths are appended to it, and it may be logged: a query, fragment or credentials in it would break or leak
  MAGICA_BASE_URL: z
    .url({ protocol: /^https?$/ })
    .refine((u) => !/[?#]/.test(u), { error: "must not contain a query string or fragment" })
    .refine((u) => {
      if (!URL.canParse(u)) return true; // already reported as not a URL
      const { username, password } = new URL(u);
      return !username && !password;
    }, { error: "must not contain a username or password" })
    .transform((u) => u.replace(/\/+$/, "")),
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
