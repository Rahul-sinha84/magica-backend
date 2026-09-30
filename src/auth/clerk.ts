import { createClerkClient, type ClerkClient } from "@clerk/backend";
import { TokenVerificationErrorReason as Reason } from "@clerk/backend/errors";
import type { Request, RequestHandler } from "express";
import { env } from "#src/env/server.js";
import { AppError } from "#src/lib/errors.js";
import { logger } from "#src/lib/logger.js";

// The only file that touches Clerk, so tests can replace it with one module mock.
//
// Auth here is a Bearer token and nothing else. Clerk's Express middleware is built for browser sessions
// (cookies, handshake redirects, special query parameters), which made a browser visit answer with a redirect
// and let a crafted query string cause a 500. So the token is verified directly, on a request that carries only
// the Authorization header: nothing else from the real request can reach Clerk.

const client = createClerkClient({ secretKey: env.CLERK_SECRET_KEY, publishableKey: env.CLERK_PUBLISHABLE_KEY });

// Anything the caller did wrong (bad, expired, forged or malformed token) is simply "not signed in". These reasons
// mean the problem is on our side or Clerk's, and a 401 would make the frontend sign the user out for nothing.
const CANNOT_VERIFY: ReadonlySet<string> = new Set([
  "unexpected-error", // Clerk unreachable
  Reason.InvalidSecretKey,
  Reason.RemoteJWKFailedToLoad,
  Reason.RemoteJWKInvalid,
  Reason.RemoteJWKMissing,
  Reason.JWKFailedToResolve,
  Reason.LocalJWKMissing,
]);

export const isVerificationOutage = (reason: string): boolean => CANNOT_VERIFY.has(reason);

const BEARER = /^Bearer\s+([A-Za-z0-9._~+/=-]{1,8192})$/i; // the characters a JWT can contain
const VERIFY_URL = "http://api.invalid/"; // only there to build a Request; Clerk never contacts it
const signedIn = new WeakMap<Request, string | null>();

// Verifying a token is local most of the time, but Clerk fetches its signing keys over the network now and then; a hung
// fetch must not hang the request with it.
export const VERIFY_TIMEOUT_MS = 8_000;

const unavailable = () => new AppError("SERVICE_UNAVAILABLE", "We couldn't verify your sign-in right now. Please try again in a moment.");

/** Verifies the Bearer token and records who it belongs to. Never rejects a request itself (see `requireUser`). */
export const createClerkAuth =
  (clerk: Pick<ClerkClient, "authenticateRequest"> = client, authorizedParties = [env.FRONTEND_ORIGIN], timeoutMs = VERIFY_TIMEOUT_MS): RequestHandler =>
  async (req, _res, next) => {
    signedIn.set(req, null);
    const token = BEARER.exec(req.get("authorization") ?? "")?.[1];
    if (token) {
      let state;
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`session token verification took longer than ${timeoutMs} ms`)), timeoutMs);
        });
        const verify = clerk.authenticateRequest(new Request(VERIFY_URL, { headers: { authorization: `Bearer ${token}` } }), {
          authorizedParties, // a token minted for some other site must not work here
          acceptsToken: "session_token",
        });
        state = await Promise.race([verify, timeout]);
      } catch (err) {
        logger.error({ err }, "session token verification failed unexpectedly");
        throw unavailable();
      } finally {
        clearTimeout(timer);
      }
      if (state.status === "signed-in") {
        signedIn.set(req, state.toAuth().userId || null); // an empty subject is never a user
      } else if (isVerificationOutage(state.reason)) {
        logger.error({ reason: state.reason }, "cannot verify session tokens");
        throw unavailable();
      }
    }
    next();
  };

export const clerkAuth = (): RequestHandler => createClerkAuth();

/** The signed-in Clerk user id, or null when the request has no valid Bearer token. */
export const clerkUserId = (req: Request): string | null => signedIn.get(req) ?? null;

export async function clerkPrimaryEmail(userId: string): Promise<string | null> {
  const user = await client.users.getUser(userId);
  return user.primaryEmailAddress?.emailAddress ?? null;
}
