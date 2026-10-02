import { z } from "zod";
import type { AudioBlock, ImageBlock, MediaAsset, MediaListQuery, MediaListResponse, VideoBlock } from "#src/contracts/index.js";
import { prisma, Prisma } from "#src/db/client.js";
import type { MediaAsset as MediaAssetRow } from "#src/generated/prisma/client.js";
import { CursorTimestampSchema, IdSchema, decodeCursor, encodeCursor } from "#src/lib/cursor.js";
import { AppError } from "#src/lib/errors.js";
import { containsPattern } from "#src/lib/search.js";

// Shared by the API (the library) and the worker (generated media is added when a tool call completes), so it must not
// import anything only one of them configures.

type Tx = Prisma.TransactionClient;

export const serializeMediaAsset = (row: MediaAssetRow): MediaAsset => ({
  id: row.id,
  source: row.source === "UPLOAD" ? "upload" : "generated",
  type: row.type === "IMAGE" ? "image" : row.type === "VIDEO" ? "video" : "audio",
  url: row.url,
  name: row.name,
  prompt: row.prompt,
  model: row.model,
  width: row.width,
  height: row.height,
  mimeType: row.mimeType,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt?.toISOString() ?? null,
});

/**
 * A link the library can store: http(s), with the scheme lowercased (the database's own check is case-sensitive, and
 * "HTTPS://…" is the same address as "https://…"). Null for anything else.
 */
export function storableUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const normalised = url.replace(/^https?:\/\//i, (scheme) => scheme.toLowerCase());
  return /^https?:\/\//.test(normalised) ? normalised : null;
}

const MEDIA_TYPE = { image: "IMAGE", video: "VIDEO", audio: "AUDIO" } as const;
// a dimension the database will accept (a positive whole number), or nothing
const dimension = (value: number | undefined) => (value !== undefined && Number.isFinite(value) && value >= 1 ? Math.round(value) : null);

/**
 * Adds what a tool call made to the user's library, inside the transaction that completes the call (so it happens
 * exactly once). Anything the database would refuse (a link that isn't http(s)) is skipped rather than allowed to
 * fail the completion, which would also stop the charge. Files are dated when the call finished, so media added later
 * (the backfill) sits on the day it was made.
 */
export async function addGeneratedMedia(tx: Tx, toolInvocationId: string, assets: readonly (ImageBlock | VideoBlock | AudioBlock)[]): Promise<number> {
  const usable = assets.flatMap((asset) => {
    const url = storableUrl(asset.url);
    return url ? [{ ...asset, url }] : [];
  });
  if (usable.length === 0) return 0;
  const invocation = await tx.toolInvocation.findUniqueOrThrow({ where: { id: toolInvocationId }, select: { completedAt: true, userId: true } });
  const { count } = await tx.mediaAsset.createMany({
    data: usable.map((asset) => ({
      userId: invocation.userId,
      source: "GENERATED" as const,
      type: MEDIA_TYPE[asset.type],
      url: asset.url,
      prompt: asset.prompt ?? null,
      model: asset.model ?? null,
      width: dimension(asset.width),
      height: dimension(asset.height),
      mimeType: asset.mimeType ?? null,
      toolInvocationId,
      ...(invocation.completedAt && { createdAt: invocation.completedAt }),
    })),
  });
  return count;
}

/**
 * The user's files for a message, in the order given: each must be in their own library and still there (an upload
 * past its lifetime is gone). Read inside the send's transaction, so what is attached is what was checked.
 */
export async function attachableAssets(tx: Tx, userId: string, refs: readonly { mediaAssetId: string }[], now = new Date()): Promise<MediaAssetRow[]> {
  if (refs.length === 0) return [];
  const rows = await tx.mediaAsset.findMany({ where: { userId, id: { in: refs.map((ref) => ref.mediaAssetId) } } });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return refs.map((ref, index) => {
    const field = `attachments.${index}`;
    const asset = byId.get(ref.mediaAssetId);
    // another user's file and one that doesn't exist look the same: nothing about other libraries leaks
    if (!asset) throw new AppError("VALIDATION_FAILED", `${field}: That file isn't in your library.`, { fields: { [field]: ["Not in your library."] } });
    if (asset.expiresAt && asset.expiresAt.getTime() <= now.getTime()) {
      throw new AppError("VALIDATION_FAILED", `${field}: This file has expired. Upload it again.`, { fields: { [field]: ["Expired."] } });
    }
    return asset;
  });
}

const MediaCursorSchema = z.tuple([CursorTimestampSchema, IdSchema]);

/**
 * The user's library, newest first, a page at a time; expired uploads are left out. A search matches file names and
 * prompts (both have trigram indexes), ignoring case, with `%` and `_` taken literally.
 */
export async function listMedia(userId: string, { source, q, cursor, limit }: MediaListQuery, now = new Date()): Promise<MediaListResponse> {
  const after = cursor ? decodeCursor(cursor, MediaCursorSchema) : undefined;
  const pattern = q ? containsPattern(q) : undefined;
  const live = Prisma.sql`m."userId" = ${userId} AND (m."expiresAt" IS NULL OR m."expiresAt" > ${now.toISOString()}::timestamp(3))`;
  const [rows, [counted]] = await Promise.all([
    prisma.$queryRaw<MediaAssetRow[]>`
      SELECT m.* FROM "MediaAsset" m
      WHERE ${live}
        ${source ? Prisma.sql`AND m."source" = ${source === "upload" ? "UPLOAD" : "GENERATED"}::"MediaSource"` : Prisma.empty}
        ${pattern ? Prisma.sql`AND (m."name" ILIKE ${pattern} OR m."prompt" ILIKE ${pattern})` : Prisma.empty}
        ${after ? Prisma.sql`AND (m."createdAt", m."id") < (${after[0].toISOString()}::timestamp(3), ${after[1]})` : Prisma.empty}
      ORDER BY m."createdAt" DESC, m."id" DESC
      LIMIT ${limit + 1}`,
    prisma.$queryRaw<{ total: bigint }[]>`SELECT count(*)::bigint AS total FROM "MediaAsset" m WHERE ${live}`,
  ]);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    media: page.map(serializeMediaAsset),
    cursor: rows.length > limit && last ? encodeCursor([last.createdAt.toISOString(), last.id]) : null,
    total: Number(counted?.total ?? 0),
  };
}
