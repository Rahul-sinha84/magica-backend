import type { Request, RequestHandler } from "express";
import { vi } from "vitest";

// Stands in for src/auth/clerk.ts. `Authorization: Bearer test:<userId>` signs that user in; anything else is
// signed out. Real Clerk token verification needs the network and real keys, so it is checked by hand.
const signedIn = new WeakMap<Request, string | null>();

/** Set a user's email answer to HANG and the fake Clerk never replies (to exercise the lookup timeout). */
export const HANG = Symbol("hang");

/** What the fake Clerk returns as a user's email: a string, an Error to throw, or HANG. */
export const clerkEmails = new Map<string, string | Error | typeof HANG>();
export const emailLookups: string[] = [];

export const resetClerkMock = () => {
  clerkEmails.clear();
  emailLookups.length = 0;
};

export const clerkModule = {
  clerkAuth: (): RequestHandler => (req, _res, next) => {
    signedIn.set(req, /^Bearer test:(.+)$/.exec(req.get("authorization") ?? "")?.[1] ?? null);
    next();
  },
  clerkUserId: (req: Request): string | null => signedIn.get(req) ?? null,
  clerkPrimaryEmail: vi.fn(async (userId: string): Promise<string | null> => {
    emailLookups.push(userId);
    const answer = clerkEmails.get(userId) ?? `${userId}@example.test`;
    if (answer === HANG) return new Promise<never>(() => {});
    if (answer instanceof Error) throw answer;
    return answer;
  }),
};
