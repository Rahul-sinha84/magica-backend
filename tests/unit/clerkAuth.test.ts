import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { TokenVerificationErrorReason as Reason } from "@clerk/backend/errors";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { api } from "../helpers/http.js";
import type * as Clerk from "#src/auth/clerk.js";
import { ErrorResponseSchema } from "#src/contracts/index.js";
import { errorHandler } from "#src/middleware/errorHandler.js";

// The real module (the suite-wide mock replaces it everywhere else). Tokens are signed locally with a throwaway
// key that the test client trusts, so this exercises Clerk's real verification without any network.
const { createClerkAuth, clerkUserId, isVerificationOutage } = await vi.importActual<typeof Clerk>("#src/auth/clerk.js");

const ORIGIN = "http://localhost:3001";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publishableKey = `pk_test_${Buffer.from("example.clerk.accounts.dev$").toString("base64")}`;
const trusting = createClerkClient({ secretKey: "sk_test_x", publishableKey, jwtKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString() });
const unreachable = createClerkClient({ secretKey: "sk_test_x", publishableKey, apiUrl: "http://127.0.0.1:9" });

const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const claims = (overrides: Record<string, unknown> = {}) => ({
  sub: "user_abc",
  sid: "sess_1",
  iat: now() - 10,
  nbf: now() - 10,
  exp: now() + 60,
  iss: "https://example.clerk.accounts.dev",
  azp: ORIGIN,
  ...overrides,
});

function token(payload: unknown = claims(), key: KeyObject = pair.privateKey, header: unknown = { alg: "RS256", typ: "JWT", kid: "ins_test" }) {
  const body = `${b64(header)}.${b64(payload)}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")}`;
}

function appWith(clerk: Parameters<typeof createClerkAuth>[0]) {
  const app = express();
  app.use(createClerkAuth(clerk, [ORIGIN]));
  app.get("/who", (req, res) => void res.json({ userId: clerkUserId(req) }));
  app.use(errorHandler);
  return app;
}
const app = appWith(trusting);
const whoAmI = (bearer?: string) => {
  const req = api(app).get("/who");
  return bearer === undefined ? req : req.set("Authorization", bearer);
};

describe("a valid token", () => {
  it("signs the user in", async () => {
    const res = await whoAmI(`Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: "user_abc" });
  });

  it("accepts the Bearer scheme in any letter case and with extra spaces before the token", async () => {
    for (const scheme of ["bearer", "BEARER", "Bearer  "]) expect((await whoAmI(`${scheme} ${token()}`)).body).toEqual({ userId: "user_abc" });
  });

  it("works for different users at once without mixing them up", async () => {
    const users = ["user_a", "user_b", "user_c", "user_d"];
    const results = await Promise.all(users.map((sub) => whoAmI(`Bearer ${token(claims({ sub }))}`)));
    expect(results.map((r) => (r.body as { userId: string }).userId)).toEqual(users);
  });
});

describe("tokens that must not sign anyone in", () => {
  const rejected: [string, () => string][] = [
    ["expired", () => token(claims({ exp: now() - 120 }))],
    ["not valid yet", () => token(claims({ nbf: now() + 600, iat: now() + 600 }))],
    ["minted for another site (wrong azp)", () => token(claims({ azp: "http://evil.example" }))],
    ["minted for a look-alike site", () => token(claims({ azp: `${ORIGIN}.evil.example` }))],
    ["missing azp", () => token(claims({ azp: undefined }))],
    ["signed with another key", () => token(claims(), otherPair.privateKey)],
    ["alg none", () => `${b64({ alg: "none", typ: "JWT" })}.${b64(claims())}.`],
    ["HS256 (algorithm confusion)", () => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims())}.${b64("anything")}`],
    ["header is not JSON", () => `${b64("!!!")}.${b64(claims())}.c2ln`],
    ["payload is not JSON", () => `${b64({ alg: "RS256", kid: "k" })}.${b64("!!!")}.c2ln`],
    ["payload is an array", () => token([1, 2])],
    ["subject is a number", () => token(claims({ sub: 123 }))],
    ["no subject", () => token(claims({ sub: undefined }))],
    ["empty subject", () => token(claims({ sub: "" }))],
    ["expiry is not a number", () => token(claims({ exp: "soon" }))],
    ["four segments", () => `${token()}.extra`],
    ["garbage", () => "not-a-jwt"],
  ];

  it.each(rejected)("%s", async (_label, make) => {
    const res = await whoAmI(`Bearer ${make()}`);
    // one object, so a failure shows the status and body together
    expect({ status: res.status, body: res.body as unknown }).toEqual({ status: 200, body: { userId: null } });
  });

  it.each([
    ["no header", undefined],
    ["wrong scheme", "Basic dXNlcjpwYXNz"],
    ["empty", "Bearer "],
    ["only spaces", "Bearer    "],
    ["two tokens", "Bearer aaa bbb"],
    ["a token with characters a JWT cannot contain", "Bearer abc<script>.def.ghi"],
    ["a non-ASCII token", "Bearer tokén.abc.def"],
    ["token far too long", `Bearer ${"a".repeat(9_000)}`],
    ["just the word Bearer", "Bearer"],
  ])("no credentials: %s", async (_label, header) => {
    expect((await whoAmI(header)).body).toEqual({ userId: null });
  });

  it("does not call Clerk at all when there is no usable token", async () => {
    const authenticateRequest = vi.fn();
    const spyApp = appWith({ authenticateRequest });
    await api(spyApp).get("/who");
    await api(spyApp).get("/who").set("Authorization", "Basic abc");
    await api(spyApp).get("/who").set("Authorization", "Bearer <bad>");
    expect(authenticateRequest).not.toHaveBeenCalled();
  });
});

describe("Bearer-only: nothing else in the request can authenticate or upset Clerk", () => {
  it("ignores a perfectly valid token that arrives in a cookie, and never redirects a browser visit", async () => {
    const res = await api(app)
      .get("/who")
      .set("Cookie", `__session=${token()}; __client_uat=${now()}`)
      .set("Sec-Fetch-Dest", "document")
      .set("Accept", "text/html");
    expect(res.status).toBe(200); // it used to be a 307 redirect to Clerk's handshake
    expect(res.headers.location).toBeUndefined();
    expect(res.body).toEqual({ userId: null });
  });

  it.each(["__clerk_handshake=abc", "__clerk_handshake_nonce=abc", "__clerk_db_jwt=abc", "__clerk_synced=true"])(
    "is not affected by the Clerk query parameter %s (this used to be a 500)",
    async (query) => {
      const res = await api(app).get(`/who?${query}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ userId: null });
    },
  );

  it("ignores a valid token passed in the query string", async () => {
    expect((await api(app).get("/who").query({ __session: token(), token: token(), access_token: token() })).body).toEqual({ userId: null });
  });

  it("prefers nothing over a cookie when the Bearer token is bad", async () => {
    const res = await whoAmI("Bearer garbage").set("Cookie", `__session=${token()}`);
    expect(res.body).toEqual({ userId: null });
  });
});

describe("when Clerk cannot verify tokens (our problem, not the user's)", () => {
  const unverifiable = token(claims(), pair.privateKey, { alg: "RS256", typ: "JWT", kid: "ins_needs_remote_key" });

  it("answers 503, not 401, so the frontend does not sign the user out", async () => {
    const res = await api(appWith(unreachable)).get("/who").set("Authorization", `Bearer ${unverifiable}`);
    expect(res.status).toBe(503);
    expect(ErrorResponseSchema.parse(res.body)).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|clerk/i);
  });

  it("still answers 401-style (signed out) for garbage, which never reaches Clerk's network calls", async () => {
    const res = await api(appWith(unreachable)).get("/who").set("Authorization", "Bearer garbage");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: null });
  });

  it("recovers on the next request (nothing sticks)", async () => {
    const flaky = appWith(unreachable);
    expect((await api(flaky).get("/who").set("Authorization", `Bearer ${unverifiable}`)).status).toBe(503);
    expect((await api(flaky).get("/who")).status).toBe(200);
  });

  it("treats an exception thrown by the SDK as unavailable too", async () => {
    const boom = appWith({ authenticateRequest: vi.fn().mockRejectedValue(new Error("socket hang up")) });
    const res = await api(boom).get("/who").set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(503);
    expect(ErrorResponseSchema.parse(res.body).code).toBe("SERVICE_UNAVAILABLE");
    expect(JSON.stringify(res.body)).not.toContain("socket hang up");
  });

  it("classifies the reasons: infrastructure problems are outages, a caller's bad token is not", () => {
    for (const outage of ["unexpected-error", Reason.InvalidSecretKey, Reason.RemoteJWKFailedToLoad, Reason.RemoteJWKInvalid, Reason.RemoteJWKMissing, Reason.JWKFailedToResolve, Reason.LocalJWKMissing]) {
      expect(isVerificationOutage(outage)).toBe(true);
    }
    for (const fine of [Reason.TokenExpired, Reason.TokenInvalid, Reason.TokenInvalidAlgorithm, Reason.TokenInvalidAuthorizedParties, Reason.TokenInvalidSignature, Reason.TokenNotActiveYet, Reason.TokenVerificationFailed, Reason.JWKKidMismatch, "session-token-nbf"]) {
      expect(isVerificationOutage(fine)).toBe(false);
    }
  });
});
