import { prisma, Prisma } from "#src/db/client.js";
import { clerkPrimaryEmail } from "#src/auth/clerk.js";
import { env } from "#src/env/server.js";
import { logger } from "#src/lib/logger.js";
import { grant } from "#src/services/credits.js";

/** Bounded, expiring set of user ids we have already confirmed exist (the oldest entry goes first when full). */
export class KnownUsers {
  private readonly expiry = new Map<string, number>(); // Map order is insertion order, so the first key is the oldest

  constructor(
    private readonly maxEntries = 10_000,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  get size(): number {
    return this.expiry.size;
  }

  has(userId: string, now = Date.now()): boolean {
    const expires = this.expiry.get(userId);
    if (expires === undefined) return false;
    if (expires <= now) {
      this.expiry.delete(userId);
      return false;
    }
    return true;
  }

  add(userId: string, now = Date.now()): void {
    this.expiry.delete(userId); // re-adding moves it to the newest position
    if (this.expiry.size >= this.maxEntries) this.expiry.delete(this.expiry.keys().next().value as string);
    this.expiry.set(userId, now + this.ttlMs);
  }

  delete(userId: string): void {
    this.expiry.delete(userId);
  }

  clear(): void {
    this.expiry.clear();
  }
}

// Users are created lazily the first time we see their Clerk id. The cache keeps the hot path free of database
// reads; entries expire so a row deleted behind our back is noticed within minutes.
const CLERK_TIMEOUT_MS = 3_000;

const known = new KnownUsers();
const inflight = new Map<string, Promise<void>>();

export const forgetUser = (userId: string) => known.delete(userId);

export function clearUserCache(): void {
  known.clear();
  inflight.clear();
}

async function fetchEmail(userId: string): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Clerk timed out")), CLERK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([clerkPrimaryEmail(userId), timeout]);
  } catch (err) {
    // the email is informational, so not having it must never stop someone from signing in
    logger.warn({ err, userId }, "could not fetch the Clerk email; creating the user without one");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function provision(userId: string): Promise<void> {
  const exists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!exists) {
    const email = await fetchEmail(userId);
    try {
      await prisma.$transaction(async (tx) => {
        await tx.user.create({ data: { id: userId, email } });
        await grant(tx, { userId, amount: env.CREDIT_STARTING_BALANCE, reason: "signup grant", idempotencyKey: `grant:signup:${userId}` });
      });
      logger.info({ userId }, "user created");
    } catch (error) {
      // another instance created the same user first; its transaction (and grant) is the one that counts
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    }
  }
  known.add(userId);
}

/** Makes sure the user exists (with their starting credits). Concurrent calls for one user share a single attempt. */
export async function ensureUser(userId: string): Promise<void> {
  if (known.has(userId)) return;

  let attempt = inflight.get(userId);
  if (!attempt) {
    attempt = provision(userId).finally(() => inflight.delete(userId));
    inflight.set(userId, attempt);
  }
  await attempt;
}
