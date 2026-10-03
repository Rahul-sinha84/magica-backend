import {
  MAX_UPLOAD_BYTES,
  MONTHLY_UPLOAD_BYTES,
  UPLOAD_LIFETIME_MS,
  type CreateUploadsResponse,
  type UploadFile,
  type UploadResult,
} from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { env } from "#src/env/server.js";
import { IdSchema } from "#src/lib/cursor.js";
import { AppError } from "#src/lib/errors.js";
import { logger } from "#src/lib/logger.js";
import {
  ASSEMBLY_ID,
  AssemblyStatusSchema,
  SIGNATURE_LIFETIME_MS,
  TransloaditUnavailable,
  createFetchAssembly,
  parseTransloaditDate,
  signedAssembly,
  verifyNotification,
  type AssemblyStatus,
  type FetchAssembly,
  type TransloaditAuth,
} from "#src/lib/transloadit.js";
import { serializeMediaAsset, storableUrl } from "#src/services/media.js";

/** Uploads one user may have signed but not finished at once: two full messages' worth. */
export const MAX_PENDING_UPLOADS = 20;

// Any fixed number: every signing request takes this lock for its transaction, so two of them can't both see room for
// the last of the monthly allowance. Signing is rare and quick, so the queue it forms is short.
export const ALLOWANCE_LOCK = 0x75706c64; // "upld"

export const NOTIFY_PATH = "/api/uploads/notify";

export function transloaditAuth(): TransloaditAuth | null {
  const { TRANSLOADIT_AUTH_KEY: key, TRANSLOADIT_AUTH_SECRET: secret } = env;
  return key && secret ? { key, secret } : null;
}

/** Where Transloadit should report finished uploads: only when this API has a public address. */
export const notifyUrl = (): string | undefined => (env.PUBLIC_API_URL ? `${env.PUBLIC_API_URL}${NOTIFY_PATH}` : undefined);

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const nextMonthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
const dayName = (at: Date) => at.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
// timestamps go to SQL as UTC text cast to the column's type, so the session's time zone can never shift them
const sqlTime = (at: Date) => at.toISOString();

interface SignDeps {
  auth?: TransloaditAuth | null;
  notifyUrl?: string;
  now?: Date;
}

/**
 * Signs one Transloadit assembly per file, in order, after checking what only the server can know: how many uploads
 * this user already has in flight, and how much of the app's monthly allowance is left. Nothing is written unless every
 * file can go. A pending upload whose signature has lapsed can no longer start, so it no longer holds any allowance.
 */
export async function createUploads(userId: string, files: UploadFile[], { auth = transloaditAuth(), notifyUrl: notify = notifyUrl(), now = new Date() }: SignDeps = {}): Promise<CreateUploadsResponse> {
  if (!auth) throw new AppError("SERVICE_UNAVAILABLE", "Uploads aren't available right now.");
  const requested = files.reduce((sum, file) => sum + file.size, 0);
  const stillStartable = new Date(now.getTime() - SIGNATURE_LIFETIME_MS);

  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ALLOWANCE_LOCK})`;

    const inFlight = await tx.upload.count({ where: { userId, status: "PENDING", createdAt: { gt: stillStartable } } });
    if (inFlight + files.length > MAX_PENDING_UPLOADS) {
      throw new AppError("RATE_LIMITED", "Too many uploads are in progress. Wait for them to finish, then try again.");
    }

    // summed in SQL as bigint: the month's total can pass the 32-bit range a single row's size fits in
    const [usage] = await tx.$queryRaw<{ used: bigint }[]>`
      SELECT COALESCE(SUM("sizeBytes"), 0)::bigint AS used FROM "Upload"
      WHERE "createdAt" >= ${sqlTime(monthStart(now))}::timestamp(3)
        AND ("status" = 'COMPLETED' OR ("status" = 'PENDING' AND "createdAt" > ${sqlTime(stillStartable)}::timestamp(3)))`;
    if (Number(usage?.used ?? 0) + requested > MONTHLY_UPLOAD_BYTES) {
      throw new AppError("UPLOAD_LIMIT_REACHED", `This month's upload allowance is used up. Uploads resume on ${dayName(nextMonthStart(now))}.`);
    }

    const created = [];
    for (const file of files) {
      created.push(await tx.upload.create({ data: { userId, originalName: file.name, mimeType: file.mimeType, sizeBytes: file.size, createdAt: now } }));
    }
    return created;
  });

  logger.info({ uploads: rows.length, bytes: requested }, "uploads signed");
  return {
    uploads: rows.map((row) => {
      const { params, signature, expiresAt } = signedAssembly(auth, { uploadId: row.id, ...(notify && { notifyUrl: notify }), now });
      return { uploadId: row.id, params, signature, expiresAt: expiresAt.toISOString() };
    }),
  };
}

// --- Finishing an upload -----------------------------------------------------------------------------------------

const MEDIA_FAMILIES = { image: "IMAGE", video: "VIDEO", audio: "AUDIO" } as const;

export type AssemblyOutcome =
  | { kind: "pending" }
  | { kind: "failed"; message: string }
  | {
      kind: "completed";
      file: { type: (typeof MEDIA_FAMILIES)[keyof typeof MEDIA_FAMILIES]; mimeType: string; size: number; url: string; width: number | null; height: number | null; expiresAt: Date };
    };

/** Transloadit's error names, in words the user can act on. */
function failureMessage(error: string): string {
  if (/CANCEL|ABORT/i.test(error)) return "The upload was cancelled.";
  if (/LIMIT|QUOTA|PAYMENT|PLAN|BILLING/i.test(error)) return "The upload service's free allowance is used up. Try again later.";
  if (/SIGNATURE|AUTH|EXPIRE/i.test(error)) return "This upload's permission expired. Choose the file again.";
  return "The upload couldn't be processed. Please try again.";
}

const positive = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.round(value) : null);

/**
 * Pure: what an assembly's status means for its upload. Transloadit's own measurements decide (the type it detected,
 * the size it received), never what the browser declared when signing.
 */
export function readAssembly(status: AssemblyStatus, now = new Date()): AssemblyOutcome {
  if (status.error) return { kind: "failed", message: failureMessage(status.error) };
  if (status.ok === "REQUEST_ABORTED" || status.ok === "ASSEMBLY_CANCELED") return { kind: "failed", message: failureMessage(status.ok) };
  if (status.ok !== "ASSEMBLY_COMPLETED") return { kind: "pending" };
  const uploads = status.uploads ?? [];
  const file = uploads[0];
  if (uploads.length !== 1 || !file) return { kind: "failed", message: "Upload one file at a time." };
  const mimeType = file.mime?.trim().toLowerCase() ?? "";
  const family = mimeType.split("/")[0] as keyof typeof MEDIA_FAMILIES;
  if (!(family in MEDIA_FAMILIES) || !mimeType.includes("/")) return { kind: "failed", message: "Only images, videos and audio can be attached." };
  const size = file.size ?? 0;
  if (size < 1) return { kind: "failed", message: "This file is empty." };
  if (size > MAX_UPLOAD_BYTES) return { kind: "failed", message: "Files can be at most 500 MB." };
  const url = storableUrl(file.ssl_url);
  if (!url?.startsWith("https://")) return { kind: "failed", message: "The upload couldn't be processed. Please try again." };
  // Transloadit deletes the file 24 hours after the upload began; we stop offering it an hour before that
  const began = parseTransloaditDate(status.start_date) ?? now;
  return {
    kind: "completed",
    file: { type: MEDIA_FAMILIES[family], mimeType, size, url, width: positive(file.meta?.width), height: positive(file.meta?.height), expiresAt: new Date(began.getTime() + UPLOAD_LIFETIME_MS) },
  };
}

/**
 * Records an outcome on a still-pending upload. The row is locked first, so the browser's report and Transloadit's
 * notification, arriving together, settle it exactly once: the second finds it already settled and changes nothing.
 */
async function settle(uploadId: string, assemblyId: string, outcome: AssemblyOutcome): Promise<void> {
  if (outcome.kind === "pending") return;
  await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ status: string; userId: string; originalName: string }[]>`
      SELECT "status", "userId", "originalName" FROM "Upload" WHERE "id" = ${uploadId} FOR UPDATE`;
    if (!row || row.status !== "PENDING") return;
    if (outcome.kind === "failed") {
      await tx.upload.update({ where: { id: uploadId }, data: { status: "FAILED", assemblyId, errorMessage: outcome.message } });
      logger.info({ uploadId, assemblyId, reason: outcome.message }, "upload failed");
      return;
    }
    const { file } = outcome;
    const asset = await tx.mediaAsset.create({
      data: { userId: row.userId, source: "UPLOAD", type: file.type, url: file.url, expiresAt: file.expiresAt, name: row.originalName, width: file.width, height: file.height, mimeType: file.mimeType },
    });
    await tx.upload.update({ where: { id: uploadId }, data: { status: "COMPLETED", assemblyId, sizeBytes: file.size, mimeType: file.mimeType, mediaAssetId: asset.id, errorMessage: null } });
    logger.info({ uploadId, assemblyId, bytes: file.size }, "upload completed");
  });
}

async function uploadResult(uploadId: string): Promise<UploadResult> {
  const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId }, include: { mediaAsset: true } });
  return {
    upload: {
      id: upload.id,
      status: upload.status === "PENDING" ? "pending" : upload.status === "COMPLETED" ? "completed" : "failed",
      errorMessage: upload.errorMessage,
      asset: upload.mediaAsset ? serializeMediaAsset(upload.mediaAsset) : null,
    },
  };
}

const uploadNotFound = () => new AppError("NOT_FOUND", "Upload not found.");
const defaultFetchAssembly = createFetchAssembly();

/**
 * The browser says its upload finished in `assemblyId`. The server asks Transloadit itself and accepts the assembly
 * only if it carries this upload's id (which only its owner was given). Asking again later is harmless: a settled
 * upload just reports where it stands.
 */
export async function completeUpload(userId: string, uploadId: string, assemblyId: string, { fetchAssembly = defaultFetchAssembly, now = new Date() }: { fetchAssembly?: FetchAssembly; now?: Date } = {}): Promise<UploadResult> {
  if (!IdSchema.safeParse(uploadId).success) throw uploadNotFound();
  const upload = await prisma.upload.findFirst({ where: { id: uploadId, userId }, select: { id: true, status: true } });
  if (!upload) throw uploadNotFound();
  if (upload.status !== "PENDING") return uploadResult(upload.id);

  let status: AssemblyStatus | null;
  try {
    status = await fetchAssembly(assemblyId);
  } catch (error) {
    if (!(error instanceof TransloaditUnavailable)) throw error;
    logger.warn({ uploadId, assemblyId, detail: error.message }, "couldn't read the assembly from Transloadit");
    throw new AppError("SERVICE_UNAVAILABLE", "We couldn't check the upload right now. Try again in a moment.");
  }
  // someone else's assembly, or one that doesn't exist, says nothing about this upload
  if (!status || status.fields?.uploadId !== uploadId || (status.assembly_id !== undefined && status.assembly_id !== assemblyId)) throw uploadNotFound();

  await settle(upload.id, assemblyId, readAssembly(status, now));
  return uploadResult(upload.id);
}

/**
 * Transloadit's own report that an assembly ended (sent to NOTIFY_PATH), checked with our secret. It settles the upload
 * named in the assembly's signed fields, so an upload completes even when its browser went away. Anything that isn't
 * one of our pending uploads is acknowledged and ignored, so Transloadit doesn't keep retrying it.
 */
export async function recordNotification(payload: unknown, signature: unknown, { auth = transloaditAuth(), now = new Date() }: { auth?: TransloaditAuth | null; now?: Date } = {}): Promise<"recorded" | "ignored"> {
  if (!auth) throw new AppError("SERVICE_UNAVAILABLE", "Uploads aren't available right now.");
  if (!verifyNotification(auth.secret, payload, signature)) throw new AppError("UNAUTHORIZED", "Invalid signature.");
  let status: AssemblyStatus;
  try {
    status = AssemblyStatusSchema.parse(JSON.parse(payload as string));
  } catch {
    throw new AppError("VALIDATION_FAILED", "The notification couldn't be read.");
  }
  const uploadId = status.fields?.uploadId;
  const assemblyId = status.assembly_id;
  if (typeof uploadId !== "string" || !IdSchema.safeParse(uploadId).success || !assemblyId || !ASSEMBLY_ID.test(assemblyId)) {
    logger.warn({ assemblyId }, "Transloadit notification without one of our upload ids; ignored");
    return "ignored";
  }
  const upload = await prisma.upload.findUnique({ where: { id: uploadId }, select: { status: true } });
  if (upload?.status !== "PENDING") return "ignored";
  await settle(uploadId, assemblyId, readAssembly(status, now));
  return "recorded";
}
