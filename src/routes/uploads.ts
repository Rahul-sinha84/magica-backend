import { Router } from "express";
import { currentUserId } from "#src/auth/middleware.js";
import { CreateUploadsBodySchema, CreateUploadsResponseSchema } from "#src/contracts/index.js";
import { createUploads } from "#src/services/uploads.js";

export const uploadsRouter = Router();

// Signed Transloadit assemblies for the files the user picked; the browser then uploads straight to Transloadit.
uploadsRouter.post("/", async (req, res) => {
  const { files } = CreateUploadsBodySchema.parse(req.body);
  res.status(201).json(CreateUploadsResponseSchema.parse(await createUploads(currentUserId(res), files)));
});
