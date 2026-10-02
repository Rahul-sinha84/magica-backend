import { Router } from "express";
import { currentUserId } from "#src/auth/middleware.js";
import { ApiKeyListResponseSchema, ApiKeyResponseSchema, CreateApiKeyBodySchema, CreateApiKeyResponseSchema, UpdateApiKeyBodySchema } from "#src/contracts/index.js";
import { AppError } from "#src/lib/errors.js";
import { IdSchema } from "#src/lib/cursor.js";
import { logger } from "#src/lib/logger.js";
import { createApiKey, listApiKeys, revokeApiKey, updateApiKey } from "#src/services/apiKeys.js";

export const apiKeysRouter = Router();

const keyId = (raw: string) => {
  const id = IdSchema.safeParse(raw);
  if (!id.success) throw new AppError("NOT_FOUND", "That key isn't there any more.");
  return id.data;
};

apiKeysRouter.get("/", async (_req, res) => {
  res.json(ApiKeyListResponseSchema.parse(await listApiKeys(currentUserId(res))));
});

// the response is the only place the key itself ever appears: it is never stored or logged
apiKeysRouter.post("/", async (req, res) => {
  const body = CreateApiKeyBodySchema.parse(req.body);
  const created = await createApiKey(currentUserId(res), body);
  logger.info({ apiKeyId: created.apiKey.id, prefix: created.apiKey.prefix }, "API key created");
  res.status(201).json(CreateApiKeyResponseSchema.parse(created));
});

apiKeysRouter.patch("/:apiKeyId", async (req, res) => {
  const changes = UpdateApiKeyBodySchema.parse(req.body);
  const apiKey = await updateApiKey(currentUserId(res), keyId(req.params.apiKeyId), changes);
  res.json(ApiKeyResponseSchema.parse({ apiKey }));
});

apiKeysRouter.delete("/:apiKeyId", async (req, res) => {
  const id = keyId(req.params.apiKeyId);
  await revokeApiKey(currentUserId(res), id);
  logger.info({ apiKeyId: id }, "API key revoked");
  res.status(204).end();
});
