import { Router } from "express";
import { forgetUser, ensureUser } from "#src/auth/users.js";
import { currentUserId } from "#src/auth/middleware.js";
import { CreditsResponseSchema } from "#src/contracts/index.js";
import { AppError } from "#src/lib/errors.js";
import { getCredits } from "#src/services/credits.js";

export const creditsRouter = Router().get("/", async (_req, res) => {
  const userId = currentUserId(res);
  let credits = await getCredits(userId);
  if (!credits) {
    // the user cache said they exist but the row is gone (deleted behind our back): start over once
    forgetUser(userId);
    await ensureUser(userId);
    credits = await getCredits(userId);
  }
  if (!credits) throw new AppError("INTERNAL_ERROR", "Your account couldn't be loaded. Please try again.");
  res.json(CreditsResponseSchema.parse(credits));
});
