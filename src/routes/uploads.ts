import express, { Router } from "express";
import { currentUserId } from "#src/auth/middleware.js";
import { CompleteUploadBodySchema, CreateUploadsBodySchema, CreateUploadsResponseSchema, UploadResultSchema } from "#src/contracts/index.js";
import type { FetchAssembly } from "#src/lib/transloadit.js";
import { completeUpload, createUploads, recordNotification } from "#src/services/uploads.js";

/** Signing and completing uploads, for the signed-in user. `fetchAssembly` is only replaced in tests. */
export function uploadsRouter({ fetchAssembly }: { fetchAssembly?: FetchAssembly } = {}) {
  const router = Router();

  // signed Transloadit assemblies for the files the user picked; the browser then uploads straight to Transloadit
  router.post("/", async (req, res) => {
    const { files } = CreateUploadsBodySchema.parse(req.body);
    res.status(201).json(CreateUploadsResponseSchema.parse(await createUploads(currentUserId(res), files)));
  });

  // the browser's report that an upload finished; the server confirms it with Transloadit
  router.post("/:uploadId/complete", async (req, res) => {
    const { assemblyId } = CompleteUploadBodySchema.parse(req.body);
    const result = await completeUpload(currentUserId(res), req.params.uploadId, assemblyId, fetchAssembly ? { fetchAssembly } : {});
    res.json(UploadResultSchema.parse(result));
  });

  return router;
}

/**
 * Transloadit's notifications (server to server, form-encoded). No user session: the HMAC over the payload, keyed with
 * our secret, is what proves it came from Transloadit, so this is mounted before sign-in is required.
 */
export const uploadNotificationsRouter = Router().post("/", express.urlencoded({ extended: false, limit: "2mb" }), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  await recordNotification(body.transloadit, body.signature);
  res.json({ received: true });
});
