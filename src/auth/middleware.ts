import type { RequestHandler, Response } from "express";
import { clerkUserId } from "#src/auth/clerk.js";
import { ensureUser } from "#src/auth/users.js";
import { AppError } from "#src/lib/errors.js";
import { addLogContext } from "#src/lib/logger.js";

/** Rejects requests without a valid session and makes sure the signed-in user exists in our database. */
export const requireUser: RequestHandler = async (req, res, next) => {
  const userId = clerkUserId(req);
  if (!userId) {
    res.setHeader("WWW-Authenticate", "Bearer");
    throw new AppError("UNAUTHORIZED", "Sign in to continue.");
  }
  await ensureUser(userId);
  res.locals.userId = userId;
  addLogContext({ userId });
  next();
};

/** The authenticated user's id inside a route that runs after `requireUser`. */
export function currentUserId(res: Response): string {
  const userId: unknown = res.locals.userId;
  if (typeof userId !== "string") throw new AppError("UNAUTHORIZED", "Sign in to continue.");
  return userId;
}
