import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UPLOAD_LIFETIME_MS } from "#src/contracts/index.js";
import { TransloaditUnavailable, createFetchAssembly, parseTransloaditDate, verifyNotification, type AssemblyStatus } from "#src/lib/transloadit.js";
import { readAssembly } from "#src/services/uploads.js";

const done = (file: Partial<NonNullable<AssemblyStatus["uploads"]>[number]> = {}, rest: Partial<AssemblyStatus> = {}): AssemblyStatus => ({
  ok: "ASSEMBLY_COMPLETED",
  start_date: "2026/10/02 10:33:07 GMT",
  uploads: [{ mime: "video/mp4", type: "video", size: 1_000, ssl_url: "https://x.r2.dev/a.mp4", meta: { width: 1920, height: 1080 }, ...file }],
  ...rest,
});

describe("readAssembly", () => {
  it("reads a finished video: type from the detected MIME, size measured, expiry 23 h after the upload began", () => {
    expect(readAssembly(done())).toEqual({
      kind: "completed",
      file: { type: "VIDEO", mimeType: "video/mp4", size: 1_000, url: "https://x.r2.dev/a.mp4", width: 1920, height: 1080, expiresAt: new Date(Date.UTC(2026, 9, 2, 10, 33, 7) + UPLOAD_LIFETIME_MS) },
    });
  });

  it("counts from now when Transloadit gives no start date it can read", () => {
    const now = new Date("2026-10-02T12:00:00.000Z");
    const outcome = readAssembly(done({}, { start_date: "yesterday" }), now);
    expect(outcome.kind === "completed" && outcome.file.expiresAt.getTime()).toBe(now.getTime() + UPLOAD_LIFETIME_MS);
  });

  it("takes audio without dimensions, and drops nonsense ones", () => {
    const outcome = readAssembly(done({ mime: "Audio/MPEG", type: "audio", meta: { width: 0, height: -3 } }));
    expect(outcome).toMatchObject({ kind: "completed", file: { type: "AUDIO", mimeType: "audio/mpeg", width: null, height: null } });
  });

  it.each(["ASSEMBLY_UPLOADING", "ASSEMBLY_EXECUTING", "ASSEMBLY_REPLAYING", undefined])("is pending while Transloadit reports %s", (ok) => {
    expect(readAssembly({ ...(ok && { ok }) })).toEqual({ kind: "pending" });
  });

  it.each([
    [{ uploads: [] }, "Upload one file at a time."],
    [{ uploads: undefined }, "Upload one file at a time."],
    [{ uploads: [{ mime: "image/png", size: 1, ssl_url: "https://x/a" }, { mime: "image/png", size: 1, ssl_url: "https://x/b" }] }, "Upload one file at a time."],
  ])("refuses an assembly without exactly one file (%#)", (rest, message) => {
    expect(readAssembly(done({}, rest as Partial<AssemblyStatus>))).toEqual({ kind: "failed", message });
  });

  it.each([null, "", "imagepng", "text/html", "application/octet-stream"])("refuses a file Transloadit detected as %j", (mime) => {
    expect(readAssembly(done({ mime }))).toEqual({ kind: "failed", message: "Only images, videos and audio can be attached." });
  });

  it("stores an upper-case scheme in the form the database accepts", () => {
    expect(readAssembly(done({ ssl_url: "HTTPS://x.r2.dev/A.mp4" }))).toMatchObject({ kind: "completed", file: { url: "https://x.r2.dev/A.mp4" } });
  });

  it("refuses a missing or non-https link", () => {
    for (const ssl_url of [null, "", "ftp://x/a", "http://x/a"]) expect(readAssembly(done({ ssl_url })).kind).toBe("failed");
  });
});

describe("parseTransloaditDate", () => {
  it("reads Transloadit's format as UTC", () => {
    expect(parseTransloaditDate("2026/01/05 03:04:05 GMT")?.toISOString()).toBe("2026-01-05T03:04:05.000Z");
  });
  it.each([undefined, "", "2026-01-05T03:04:05Z", "2026/13/45 99:99:99 GMT", "2026/02/30 10:00:00 GMT", "2026/01/05 03:04:05"])("gives up on %j", (value) => {
    expect(parseTransloaditDate(value)).toBeUndefined();
  });
});

describe("verifyNotification", () => {
  const secret = "s3cret";
  const payload = '{"ok":"ASSEMBLY_COMPLETED"}';
  const good = createHmac("sha1", secret).update(payload).digest("hex");
  it("accepts the lowercase hex HMAC-SHA1 of the exact payload", () => {
    expect(verifyNotification(secret, payload, good)).toBe(true);
  });
  it.each([
    ["another secret", createHmac("sha1", "nope").update(payload).digest("hex")],
    ["uppercase", good.toUpperCase()],
    ["a prefix", `sha1:${good}`],
    ["too short", good.slice(0, 39)],
    ["not a string", 42],
  ])("refuses %s", (_label, signature) => {
    expect(verifyNotification(secret, payload, signature)).toBe(false);
  });
  it("refuses a payload that isn't a string, or one changed by a single byte", () => {
    expect(verifyNotification(secret, { ok: 1 }, good)).toBe(false);
    expect(verifyNotification(secret, `${payload} `, good)).toBe(false);
  });
});

describe("createFetchAssembly", () => {
  const id = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const answer = (status: number, body: unknown) => () => Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  const read = (fetchImpl: () => Promise<Response>) => createFetchAssembly({ fetchImpl: fetchImpl })(id);

  it("returns the status Transloadit reports", async () => {
    expect(await read(answer(200, { ok: "ASSEMBLY_COMPLETED", fields: { uploadId: "x" } }))).toMatchObject({ ok: "ASSEMBLY_COMPLETED", fields: { uploadId: "x" } });
  });
  it("is null for an assembly Transloadit doesn't know, and never asks about an id that can't be one", async () => {
    expect(await read(answer(404, { error: "ASSEMBLY_NOT_FOUND" }))).toBeNull();
    let asked = false;
    expect(await createFetchAssembly({ fetchImpl: (() => ((asked = true), Promise.resolve(new Response("{}")))) })("../etc")).toBeNull();
    expect(asked).toBe(false);
  });
  it.each([
    ["an outage", answer(503, { error: "SERVER_ERROR" })],
    ["an answer that isn't JSON", answer(200, "<html>")],
    ["a status of the wrong shape", answer(200, { uploads: "lots" })],
    ["an oversized answer", answer(200, JSON.stringify({ ok: "x", pad: "y".repeat(1_100_000) }))],
    ["a network error", () => Promise.reject(new Error("socket hang up"))],
  ])("throws TransloaditUnavailable for %s", async (_label, fetchImpl) => {
    await expect(read(fetchImpl)).rejects.toBeInstanceOf(TransloaditUnavailable);
  });
});
