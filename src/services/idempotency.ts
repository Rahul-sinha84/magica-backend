import { createHash } from "node:crypto";
import { IDEMPOTENCY_KEY_PATTERN, IDEMPOTENCY_WINDOW_MS } from "#src/contracts/index.js";
import { prisma, Prisma } from "#src/db/client.js";
import { AppError } from "#src/lib/errors.js";
import { toJson } from "#src/services/runs.js";

// Idempotency-Key on the public API's starts: the first request claims the key (a PENDING record), does the work and
// stores its answer; a repeat with the same body gets that answer back instead of doing the work twice.

export interface StoredResponse {
  status: number;
  body: unknown;
}

export interface IdempotentResult extends StoredResponse {
  /** true when this is the stored answer to an earlier request */
  replayed: boolean;
}

/** A stable hash of a request body: the same JSON (whatever the key order) gives the same hash. */
export function requestHash(body: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(body ?? null))).digest("hex");
}

/** The key from the header, checked; undefined when the header isn't there. */
export function parseIdempotencyKey(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (!IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new AppError("VALIDATION_FAILED", "Idempotency-Key: Use 1 to 255 visible ASCII characters.", { fields: { "Idempotency-Key": ["invalid"] } });
  }
  return header;
}

const conflict = (message: string) => new AppError("IDEMPOTENCY_CONFLICT", message);
const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/**
 * Runs `work` once per (user, scope, key, body). Without a key it just runs. A repeat of a finished request gets the
 * stored answer; a repeat with a different body, or one that arrives while the first is still running, is refused
 * (409). If `work` fails, the key is released so the request can be tried again with it. After 24 hours a key is
 * free to be used again.
 */
export async function withIdempotency(
  { userId, scope, key, body, now = new Date() }: { userId: string; scope: string; key: string | undefined; body: unknown; now?: Date },
  work: () => Promise<StoredResponse>,
): Promise<IdempotentResult> {
  if (key === undefined) return { ...(await work()), replayed: false };
  const hash = requestHash(body);
  const where = { userId_scope_key: { userId, scope, key } };

  let claimed = false;
  for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
    try {
      await prisma.idempotencyRecord.create({ data: { userId, scope, key, requestHash: hash } });
      claimed = true; // ours: do the work
      break;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const existing = await prisma.idempotencyRecord.findUnique({ where });
    if (!existing) continue; // released a moment ago: claim it
    if (now.getTime() - existing.createdAt.getTime() >= IDEMPOTENCY_WINDOW_MS) {
      await prisma.idempotencyRecord.deleteMany({ where: { id: existing.id } }); // expired: the key is free again
      continue;
    }
    if (existing.requestHash !== hash) throw conflict("This Idempotency-Key was already used for a different request.");
    if (existing.status === "PENDING" || existing.responseStatus === null) break;
    return { status: existing.responseStatus, body: existing.responseBody, replayed: true };
  }
  if (!claimed) throw conflict("A request with this Idempotency-Key is still being handled. Try again in a moment.");

  let result: StoredResponse;
  try {
    result = await work();
  } catch (error) {
    await prisma.idempotencyRecord.deleteMany({ where: { userId, scope, key, status: "PENDING" } }); // free to try again
    throw error;
  }
  await prisma.idempotencyRecord.update({ where, data: { status: "DONE", responseStatus: result.status, responseBody: toJson(result.body) } });
  return { ...result, replayed: false };
}
