import { Router } from "express";
import { ModelsResponseSchema } from "#src/contracts/index.js";
import { getModels } from "#src/services/models.js";

export const modelsRouter = Router().get("/", async (_req, res) => {
  res.json(ModelsResponseSchema.parse(await getModels()));
});
