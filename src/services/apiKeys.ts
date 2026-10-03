import { MAX_ACTIVE_API_KEYS, type ApiKey, type CreateApiKeyBody, type UpdateApiKeyBody } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import type { ApiKey as ApiKeyRow } from "#src/generated/prisma/client.js";
import { API_KEY_PATTERN, generateApiKey, hashApiKey } from "#src/lib/apiKeys.js";
import { AppError } from "#src/lib/errors.js";

// The user's API keys: create (the key is shown once), list, rename or change limits, revoke. Revoking is final and a
// revoked key disappears from the list; it is kept (as a hash) so the public API can tell it was revoked.

const notFound = () => new AppError("NOT_FOUND", "That key isn't there any more.");

/** Working: not revoked, and not past its expiry. */
const activeWhere = (now: Date) => ({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

export function serializeApiKey(row: ApiKeyRow, now = new Date()): ApiKey {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    perMinute: row.perMinute,
    perDay: row.perDay,
    status: row.expiresAt && row.expiresAt.getTime() <= now.getTime() ? "expired" : "active",
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Creates a key and returns it with its secret, which is never stored and can't be shown again. At most
 * MAX_ACTIVE_API_KEYS may be active: the user's row is locked while counting, so two creates at once can't both
 * take the last place.
 */
export async function createApiKey(userId: string, body: CreateApiKeyBody, now = new Date()): Promise<{ apiKey: ApiKey; secret: string }> {
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    throw new AppError("VALIDATION_FAILED", "expiresAt: Choose a time in the future.", { fields: { expiresAt: ["must be in the future"] } });
  }
  const { secret, prefix, hash } = generateApiKey();
  const row = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const active = await tx.apiKey.count({ where: { userId, ...activeWhere(now) } });
    if (active >= MAX_ACTIVE_API_KEYS) {
      throw new AppError("API_KEY_LIMIT_REACHED", `You can have at most ${MAX_ACTIVE_API_KEYS} active API keys. Revoke one to create another.`);
    }
    return tx.apiKey.create({ data: { userId, label: body.label, prefix, hash, perMinute: body.perMinute, perDay: body.perDay, expiresAt } });
  });
  return { apiKey: serializeApiKey(row, now), secret };
}

/** The user's keys that aren't revoked, newest first, and how many are active (the "n/10" counter). */
export async function listApiKeys(userId: string, now = new Date()) {
  const rows = await prisma.apiKey.findMany({ where: { userId, revokedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const apiKeys = rows.map((row) => serializeApiKey(row, now));
  return { apiKeys, activeCount: apiKeys.filter((key) => key.status === "active").length, maxActive: MAX_ACTIVE_API_KEYS };
}

/** Renames a key or changes its limits. A revoked key (or another user's) is not found. */
export async function updateApiKey(userId: string, id: string, changes: UpdateApiKeyBody, now = new Date()): Promise<ApiKey> {
  const { count } = await prisma.apiKey.updateMany({ where: { id, userId, revokedAt: null }, data: changes });
  if (count === 0) throw notFound();
  return serializeApiKey(await prisma.apiKey.findUniqueOrThrow({ where: { id } }), now);
}

/** Revokes a key for good. Revoking it again is harmless; another user's key is not found. */
export async function revokeApiKey(userId: string, id: string, now = new Date()): Promise<void> {
  const key = await prisma.apiKey.findFirst({ where: { id, userId }, select: { revokedAt: true } });
  if (!key) throw notFound();
  if (!key.revokedAt) await prisma.apiKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } });
}

/**
 * The key a request presents, if it works: found by its hash, not revoked, not expired. Null for anything else
 * (the caller answers 401 without saying which). Used by the public API.
 */
export async function findWorkingApiKey(secret: string, now = new Date()): Promise<ApiKeyRow | null> {
  if (!API_KEY_PATTERN.test(secret)) return null;
  return prisma.apiKey.findFirst({ where: { hash: hashApiKey(secret), ...activeWhere(now) } });
}
