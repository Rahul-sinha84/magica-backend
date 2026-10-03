import type { Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { clerkUserId } from "#src/auth/clerk.js";
import { AppError } from "#src/lib/errors.js";

// In-memory counters: correct for one instance, per-instance when scaled out (documented trade-off).
const WINDOW_MS = 60_000;

const common = {
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // through the normal error path, so the body has the same shape as every other error
  handler: (_req: Request, _res: unknown, next: (error: unknown) => void) =>
    next(new AppError("RATE_LIMITED", "Too many requests. Wait a moment and try again.")),
} as const;

export interface ApiLimits {
  windowMs?: number;
  authenticated?: number;
  anonymous?: number;
}

/**
 * Counts per signed-in user (across all their tabs); anything without a valid session is counted per IP and
 * gets a much lower allowance. A fresh instance has fresh counters, which keeps tests independent.
 */
export const createApiRateLimit = ({ windowMs = WINDOW_MS, authenticated = 300, anonymous = 60 }: ApiLimits = {}) =>
  rateLimit({
    ...common,
    windowMs,
    limit: (req) => (clerkUserId(req) ? authenticated : anonymous),
    keyGenerator: (req) => {
      const userId = clerkUserId(req);
      return userId ? `user:${userId}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;
    },
  });

/**
 * Sending a message starts an LLM run, the expensive operation, so it gets its own small per-user allowance. The user is
 * whoever the request was authenticated as (a session or an API key), so the app and the public API share one count.
 */
export const createMessageSendRateLimit = ({ windowMs = WINDOW_MS, limit = 10 } = {}) =>
  rateLimit({
    ...common,
    windowMs,
    limit,
    keyGenerator: (req, res) => {
      const userId: unknown = res.locals.userId;
      return `user:${typeof userId === "string" ? userId : (clerkUserId(req) ?? ipKeyGenerator(req.ip ?? ""))}`;
    },
  });
