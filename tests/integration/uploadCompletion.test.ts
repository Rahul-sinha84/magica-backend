import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "#src/app.js";
import { ErrorResponseSchema, UPLOAD_LIFETIME_MS, UploadResultSchema } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { TransloaditUnavailable, type AssemblyStatus } from "#src/lib/transloadit.js";
import { completeUpload, createUploads, recordNotification } from "#src/services/uploads.js";
import { api } from "../helpers/http.js";
import { fixtures, resetDb } from "../helpers/db.js";

beforeEach(resetDb);

const AUTH = { key: "transloadit-test-key", secret: "transloadit-test-secret" };
const ASSEMBLY = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const OTHER_ASSEMBLY = "ffffffffffffffffffffffffffffffff";

// What Transloadit would answer for each assembly id; a function makes it throw (Transloadit unreachable).
let assemblies: Record<string, AssemblyStatus | (() => never)> = {};
const fakeFetchAssembly = (id: string) => {
  const entry = assemblies[id];
  if (typeof entry === "function") return Promise.resolve(entry());
  return Promise.resolve(entry ?? null);
};
const app = createApp({ rateLimits: { authenticated: 1_000_000, anonymous: 1_000_000 }, sendLimit: 1_000_000, fetchAssembly: fakeFetchAssembly });
const asUser = (userId: string) => ({ post: (path: string) => api(app).post(path).set("Authorization", `Bearer test:${userId}`) });

beforeEach(() => {
  assemblies = {};
});

/** A pending upload for the user, as the signing step leaves it. */
async function pendingUpload(userId = "u1", name = "sunset.png") {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, balance: 1_000_000 } });
  const { uploads } = await createUploads(userId, [{ name, size: 5_000, mimeType: "image/png" }], { auth: AUTH });
  return uploads[0]!.uploadId;
}

/** A finished assembly as Transloadit reports it (only the fields we read). */
function finished(uploadId: string, overrides: Partial<AssemblyStatus> = {}, file: Partial<NonNullable<AssemblyStatus["uploads"]>[number]> = {}): AssemblyStatus {
  return {
    ok: "ASSEMBLY_COMPLETED",
    assembly_id: ASSEMBLY,
    start_date: "2026/10/02 10:33:07 GMT",
    fields: { uploadId },
    uploads: [{ mime: "image/png", type: "image", size: 3_771, ssl_url: "https://pub-abc.r2.dev/ws/asm/file.png", meta: { width: 64, height: 48 }, ...file }],
    ...overrides,
  };
}

async function complete(userId: string, uploadId: string, assemblyId = ASSEMBLY) {
  return asUser(userId).post(`/api/uploads/${uploadId}/complete`).send({ assemblyId });
}

async function completed(userId: string, uploadId: string, assemblyId = ASSEMBLY) {
  const res = await complete(userId, uploadId, assemblyId);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return UploadResultSchema.parse(res.body).upload;
}

describe("POST /api/uploads/:uploadId/complete", () => {
  it("records the file in the library from what Transloadit measured, with its expiry", async () => {
    const uploadId = await pendingUpload();
    assemblies[ASSEMBLY] = finished(uploadId);
    const upload = await completed("u1", uploadId);
    expect(upload).toMatchObject({ id: uploadId, status: "completed", errorMessage: null });
    expect(upload.asset).toMatchObject({
      source: "upload",
      type: "image",
      url: "https://pub-abc.r2.dev/ws/asm/file.png",
      name: "sunset.png",
      width: 64,
      height: 48,
      mimeType: "image/png",
      prompt: null,
      model: null,
      expiresAt: new Date(Date.UTC(2026, 9, 2, 10, 33, 7) + UPLOAD_LIFETIME_MS).toISOString(),
    });
    const row = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } });
    expect(row).toMatchObject({ status: "COMPLETED", assemblyId: ASSEMBLY, sizeBytes: 3_771, mimeType: "image/png", mediaAssetId: upload.asset!.id });
  });

  it("answers the same again when asked twice (or with another assembly), adding nothing", async () => {
    const uploadId = await pendingUpload();
    assemblies[ASSEMBLY] = finished(uploadId);
    const first = await completed("u1", uploadId);
    assemblies[OTHER_ASSEMBLY] = finished(uploadId, { assembly_id: OTHER_ASSEMBLY }, { ssl_url: "https://pub-abc.r2.dev/other.png" });
    expect(await completed("u1", uploadId)).toEqual(first);
    expect(await completed("u1", uploadId, OTHER_ASSEMBLY)).toEqual(first);
    expect(await prisma.mediaAsset.count()).toBe(1);
  });

  it("says pending while Transloadit is still working, changing nothing, then completes", async () => {
    const uploadId = await pendingUpload();
    assemblies[ASSEMBLY] = { ok: "ASSEMBLY_EXECUTING", assembly_id: ASSEMBLY, fields: { uploadId } };
    expect(await completed("u1", uploadId)).toMatchObject({ status: "pending", asset: null, errorMessage: null });
    expect((await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } })).status).toBe("PENDING");
    assemblies[ASSEMBLY] = finished(uploadId);
    expect((await completed("u1", uploadId)).status).toBe("completed");
  });

  it.each([
    ["a failed assembly", { error: "INVALID_SIGNATURE", ok: undefined }, {}, "This upload's permission expired. Choose the file again."],
    ["a cancelled one", { ok: "ASSEMBLY_CANCELED" }, {}, "The upload was cancelled."],
    ["the free allowance used up", { error: "GB_QUOTA_REACHED", ok: undefined }, {}, "The upload service's free allowance is used up. Try again later."],
    ["something else going wrong", { error: "INTERNAL_COMMAND_ERROR", ok: undefined }, {}, "The upload couldn't be processed. Please try again."],
    ["a PDF in disguise", {}, { mime: "application/pdf", type: "document" }, "Only images, videos and audio can be attached."],
    ["an empty file", {}, { size: 0 }, "This file is empty."],
    ["a file over 500 MB", {}, { size: 500_000_001 }, "Files can be at most 500 MB."],
    ["a link that isn't https", {}, { ssl_url: "http://pub-abc.r2.dev/file.png" }, "The upload couldn't be processed. Please try again."],
  ])("marks the upload failed, with a safe reason, for %s", async (_label, overrides, file, message) => {
    const uploadId = await pendingUpload();
    assemblies[ASSEMBLY] = finished(uploadId, overrides, file);
    expect(await completed("u1", uploadId)).toMatchObject({ status: "failed", errorMessage: message, asset: null });
    expect(await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } })).toMatchObject({ status: "FAILED", errorMessage: message, assemblyId: ASSEMBLY });
    expect(await prisma.mediaAsset.count()).toBe(0);
  });

  it("refuses an assembly with more than one file", async () => {
    const uploadId = await pendingUpload();
    const status = finished(uploadId);
    assemblies[ASSEMBLY] = { ...status, uploads: [...status.uploads!, ...status.uploads!] };
    expect(await completed("u1", uploadId)).toMatchObject({ status: "failed", errorMessage: "Upload one file at a time." });
  });

  it.each([
    ["another user's upload", "u2", (id: string) => finished(id), ASSEMBLY],
    ["an assembly carrying a different upload id", "u1", () => finished("cmuqzzzzz0000zzzzzzzzzzzz"), ASSEMBLY],
    ["an assembly whose status names another assembly", "u1", (id: string) => finished(id, { assembly_id: OTHER_ASSEMBLY }), ASSEMBLY],
    ["an assembly Transloadit doesn't know", "u1", () => undefined, OTHER_ASSEMBLY],
  ])("is 404 for %s, changing nothing", async (_label, caller, status, assemblyId) => {
    const uploadId = await pendingUpload("u1");
    await prisma.user.upsert({ where: { id: "u2" }, update: {}, create: { id: "u2", balance: 1 } });
    const value = status(uploadId);
    if (value) assemblies[ASSEMBLY] = value;
    const res = await complete(caller, uploadId, assemblyId);
    expect(res.status).toBe(404);
    expect(ErrorResponseSchema.parse(res.body).error).toBe("Upload not found.");
    expect((await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } })).status).toBe("PENDING");
  });

  it("is 503, changing nothing, when Transloadit can't be asked", async () => {
    const uploadId = await pendingUpload();
    assemblies[ASSEMBLY] = () => {
      throw new TransloaditUnavailable("timeout");
    };
    const res = await complete("u1", uploadId);
    expect(res.status).toBe(503);
    expect(ErrorResponseSchema.parse(res.body).error).toBe("We couldn't check the upload right now. Try again in a moment.");
    expect((await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } })).status).toBe("PENDING");
  });

  it("refuses an assembly id that can't be one (400) and an upload id that can't exist (404)", async () => {
    const uploadId = await pendingUpload();
    expect((await complete("u1", uploadId, "../../etc/passwd")).status).toBe(400);
    expect((await complete("u1", uploadId, ASSEMBLY.toUpperCase())).status).toBe(400);
    expect((await complete("u1", "not a real id!", ASSEMBLY)).status).toBe(404);
  });

  it("needs a signed-in user", async () => {
    expect((await api(app).post("/api/uploads/x/complete").send({ assemblyId: ASSEMBLY })).status).toBe(401);
  });
});

// --- Transloadit's notifications ------------------------------------------------------------------------------------

const sign = (payload: string, secret = AUTH.secret) => createHmac("sha1", secret).update(payload).digest("hex");
const notify = (payload: string, signature: string) => api(app).post("/api/uploads/notify").type("form").send({ transloadit: payload, signature });

describe("POST /api/uploads/notify (Transloadit's report, no user session)", () => {
  it("completes a pending upload from a correctly signed report, without any sign-in", async () => {
    const uploadId = await pendingUpload();
    const payload = JSON.stringify(finished(uploadId));
    const res = await notify(payload, sign(payload));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } })).toMatchObject({ status: "COMPLETED", assemblyId: ASSEMBLY });
    expect(await prisma.mediaAsset.count()).toBe(1);
  });

  it("records a failed assembly as a failed upload", async () => {
    const uploadId = await pendingUpload();
    const payload = JSON.stringify(finished(uploadId, { ok: undefined, error: "ASSEMBLY_CANCELED" }));
    expect((await notify(payload, sign(payload))).status).toBe(200);
    expect(await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } })).toMatchObject({ status: "FAILED", errorMessage: "The upload was cancelled." });
  });

  it.each([
    ["signed with another secret", (p: string) => sign(p, "someone-else")],
    ["with an uppercase signature", (p: string) => sign(p).toUpperCase()],
    ["with a SHA-384 signature", (p: string) => createHmac("sha384", AUTH.secret).update(p).digest("hex")],
    ["with no signature", () => ""],
  ])("refuses a report %s (401), changing nothing", async (_label, signature) => {
    const uploadId = await pendingUpload();
    const payload = JSON.stringify(finished(uploadId));
    expect((await notify(payload, signature(payload))).status).toBe(401);
    expect((await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } })).status).toBe("PENDING");
  });

  it("refuses a report whose payload was changed after signing", async () => {
    const uploadId = await pendingUpload();
    const payload = JSON.stringify(finished(uploadId));
    const tampered = payload.replace("file.png", "evil.png");
    expect((await notify(tampered, sign(payload))).status).toBe(401);
  });

  it("acknowledges (200) and ignores reports that aren't about one of our pending uploads", async () => {
    const uploadId = await pendingUpload();
    assemblies[ASSEMBLY] = finished(uploadId);
    await completed("u1", uploadId); // already settled
    for (const status of [finished(uploadId, {}, { ssl_url: "https://pub-abc.r2.dev/late.png" }), finished("cmuqzzzzz0000zzzzzzzzzzzz"), { ...finished(uploadId), fields: {} }]) {
      const payload = JSON.stringify(status);
      expect((await notify(payload, sign(payload))).status).toBe(200);
    }
    expect(await prisma.mediaAsset.count()).toBe(1);
    expect((await prisma.mediaAsset.findFirstOrThrow()).url).toBe("https://pub-abc.r2.dev/ws/asm/file.png");
  });

  it("is 400 for a signed payload that isn't an assembly status", async () => {
    expect((await notify("not json", sign("not json"))).status).toBe(400);
  });

  it("answers unavailable when the server has no Transloadit keys", async () => {
    await expect(recordNotification("{}", sign("{}"), { auth: null })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});

describe("the browser's report and Transloadit's arriving together", () => {
  it("settle the upload exactly once", async () => {
    const uploadId = await pendingUpload();
    const status = finished(uploadId);
    const payload = JSON.stringify(status);
    const results = await Promise.all([
      completeUpload("u1", uploadId, ASSEMBLY, { fetchAssembly: () => Promise.resolve(status) }),
      recordNotification(payload, sign(payload), { auth: AUTH }),
      completeUpload("u1", uploadId, ASSEMBLY, { fetchAssembly: () => Promise.resolve(status) }),
      recordNotification(payload, sign(payload), { auth: AUTH }),
    ]);
    expect(await prisma.mediaAsset.count()).toBe(1);
    const asset = await prisma.mediaAsset.findFirstOrThrow();
    expect((results[0] as { upload: { asset: { id: string } } }).upload.asset.id).toBe(asset.id);
  });
});

describe("settling locks the upload row", () => {
  it("waits for another transaction holding the row, then finds it settled and adds nothing", async () => {
    const uploadId = await pendingUpload();
    const status = finished(uploadId);
    let releasedAt = 0;
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    // stands in for a concurrent report: holds the row, then settles it itself
    const other = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Upload" WHERE "id" = ${uploadId} FOR UPDATE`;
      locked();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await tx.upload.update({ where: { id: uploadId }, data: { status: "FAILED", assemblyId: ASSEMBLY, errorMessage: "settled elsewhere" } });
      releasedAt = Date.now();
    });
    await holding;
    const result = await completeUpload("u1", uploadId, ASSEMBLY, { fetchAssembly: () => Promise.resolve(status) });
    const answeredAt = Date.now();
    await other;
    expect(answeredAt).toBeGreaterThanOrEqual(releasedAt);
    expect(result.upload).toMatchObject({ status: "failed", errorMessage: "settled elsewhere" });
    expect(await prisma.mediaAsset.count()).toBe(0);
  });
});

describe("signing asks Transloadit to report back when the API is public", () => {
  it("adds notify_url to the signed params only when there is a public address", async () => {
    await fixtures.user({ id: "u1" });
    const withUrl = await createUploads("u1", [{ name: "a.png", size: 1, mimeType: "image/png" }], { auth: AUTH, notifyUrl: "https://api.example.com/api/uploads/notify" });
    expect((JSON.parse(withUrl.uploads[0]!.params) as { notify_url?: string }).notify_url).toBe("https://api.example.com/api/uploads/notify");
    const withoutUrl = await createUploads("u1", [{ name: "b.png", size: 1, mimeType: "image/png" }], { auth: AUTH });
    expect((JSON.parse(withoutUrl.uploads[0]!.params) as { notify_url?: string }).notify_url).toBeUndefined();
  });
});
