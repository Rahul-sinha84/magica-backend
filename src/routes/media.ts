import { Router } from "express";
import { currentUserId } from "#src/auth/middleware.js";
import { MediaListQuerySchema, MediaListResponseSchema } from "#src/contracts/index.js";
import { listMedia } from "#src/services/media.js";

// The media library: the user's uploads and generated media, newest first, expired uploads left out.
export const mediaRouter = Router().get("/", async (req, res) => {
  const query = MediaListQuerySchema.parse(req.query);
  res.json(MediaListResponseSchema.parse(await listMedia(currentUserId(res), query)));
});
