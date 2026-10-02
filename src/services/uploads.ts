import { MONTHLY_UPLOAD_BYTES, type CreateUploadsResponse, type UploadFile } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { env } from "#src/env/server.js";
import { AppError } from "#src/lib/errors.js";
import { logger } from "#src/lib/logger.js";
import { SIGNATURE_LIFETIME_MS, signedAssembly, type TransloaditAuth } from "#src/lib/transloadit.js";

/** Uploads one user may have signed but not finished at once: two full messages' worth. */
export const MAX_PENDING_UPLOADS = 20;

// Any fixed number: every signing request takes this lock for its transaction, so two of them can't both see room for
// the last of the monthly allowance. Signing is rare and quick, so the queue it forms is short.
export const ALLOWANCE_LOCK = 0x75706c64; // "upld"

export function transloaditAuth(): TransloaditAuth | null {
  const { TRANSLOADIT_AUTH_KEY: key, TRANSLOADIT_AUTH_SECRET: secret } = env;
  return key && secret ? { key, secret } : null;
}

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const nextMonthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
const dayName = (at: Date) => at.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

interface Deps {
  auth?: TransloaditAuth | null;
  now?: Date;
}

/**
 * Signs one Transloadit assembly per file, in order, after checking what only the server can know: how many uploads
 * this user already has in flight, and how much of the app's monthly allowance is left. Nothing is written unless every
 * file can go. A pending upload whose signature has lapsed can no longer start, so it no longer holds any allowance.
 */
export async function createUploads(userId: string, files: UploadFile[], { auth = transloaditAuth(), now = new Date() }: Deps = {}): Promise<CreateUploadsResponse> {
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
      WHERE "createdAt" >= ${monthStart(now)}
        AND ("status" = 'COMPLETED' OR ("status" = 'PENDING' AND "createdAt" > ${stillStartable}))`;
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
      const { params, signature, expiresAt } = signedAssembly(auth, { uploadId: row.id, now });
      return { uploadId: row.id, params, signature, expiresAt: expiresAt.toISOString() };
    }),
  };
}
