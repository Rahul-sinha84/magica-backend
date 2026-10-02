import { beforeEach, describe, expect, it } from "vitest";
import { CreateUploadsResponseSchema, ErrorResponseSchema, MAX_UPLOAD_BYTES, MONTHLY_UPLOAD_BYTES } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { signParams } from "#src/lib/transloadit.js";
import { ALLOWANCE_LOCK, MAX_PENDING_UPLOADS, createUploads } from "#src/services/uploads.js";
import { anonymous, as } from "../helpers/app.js";
import { fixtures, resetDb } from "../helpers/db.js";

beforeEach(resetDb);

// the placeholder keys vitest.config.ts gives every test process
const AUTH = { key: "transloadit-test-key", secret: "transloadit-test-secret" };

const png = (name = "photo.png", size = 1_000) => ({ name, size, mimeType: "image/png" as const });

const post = (userId: string, body: unknown) => as(userId).post("/api/uploads").send(body as object);

async function ok(userId: string, files: unknown[]) {
  const res = await post(userId, { files });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return CreateUploadsResponseSchema.parse(res.body);
}

async function refused(userId: string, body: unknown, status = 400) {
  const res = await post(userId, body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return ErrorResponseSchema.parse(res.body);
}

/** Uploads already recorded, to fill the month's allowance or a user's in-flight slots. */
async function seedUploads(userId: string, rows: { size: number; status?: "PENDING" | "COMPLETED" | "FAILED"; createdAt?: Date }[]) {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, balance: 1_000_000 } });
  for (const [i, row] of rows.entries()) {
    await prisma.upload.create({
      data: { userId, originalName: `seed-${i}.png`, mimeType: "image/png", sizeBytes: row.size, status: row.status ?? "COMPLETED", ...(row.status === "COMPLETED" || !row.status ? { assemblyId: `asm-${userId}-${i}` } : {}), ...(row.createdAt && { createdAt: row.createdAt }) },
    });
  }
}

describe("POST /api/uploads: signing", () => {
  it("needs a signed-in user", async () => {
    expect((await anonymous().post("/api/uploads").send({ files: [png()] })).status).toBe(401);
  });

  it("signs one assembly per file, in order, and records each as a pending upload", async () => {
    const body = await ok("u1", [png("a.png", 1_234), { name: "clip.mp4", size: 5_000_000, mimeType: "video/mp4" }]);
    expect(body.uploads).toHaveLength(2);
    const rows = await prisma.upload.findMany({ where: { userId: "u1" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.originalName, r.mimeType, r.sizeBytes, r.status])).toEqual([
      ["a.png", "image/png", 1_234, "PENDING"],
      ["clip.mp4", "video/mp4", 5_000_000, "PENDING"],
    ]);
    // the response keeps the request's order
    expect(body.uploads.map((u) => u.uploadId)).toEqual([rows[0]?.id, rows[1]?.id]);
  });

  it("gives Transloadit-ready params: our key, a 30-minute expiry, our upload id, signed with the secret", async () => {
    const before = Date.now();
    const { uploads } = await ok("u1", [png()]);
    const upload = uploads[0]!;
    const params = JSON.parse(upload.params) as { auth: { key: string; expires: string }; fields: Record<string, string>; steps: Record<string, unknown> };
    expect(params.auth.key).toBe(AUTH.key);
    expect(params.fields).toEqual({ uploadId: upload.uploadId });
    expect(params.steps).toEqual({ ":original": { robot: "/upload/handle" } });
    expect(upload.signature).toBe(signParams(upload.params, AUTH.secret));
    const expires = Date.parse(upload.expiresAt);
    expect(expires - before).toBeGreaterThanOrEqual(30 * 60_000 - 1_000);
    expect(expires - before).toBeLessThanOrEqual(30 * 60_000 + 5_000);
  });

  it("never sends the secret to the browser", async () => {
    const res = await post("u1", { files: [png()] });
    expect(JSON.stringify(res.body)).not.toContain(AUTH.secret);
  });

  it("accepts every supported spelling of the media types magica accepts", async () => {
    const files = [
      { name: "a.JPG", size: 1, mimeType: "image/jpeg" },
      { name: "b.heic", size: 1, mimeType: "image/heic" },
      { name: "c.mov", size: 1, mimeType: "video/quicktime" },
      { name: "d.webm", size: 1, mimeType: "video/webm" },
      { name: "e.mp3", size: 1, mimeType: "audio/mpeg" },
      { name: "f.wav", size: 1, mimeType: "audio/x-wav" },
      { name: "g.m4a", size: 1, mimeType: "audio/mp4" },
      { name: "h.m4a", size: 1, mimeType: "audio/x-m4a" },
      { name: "i.gif", size: 1, mimeType: "image/gif" },
      { name: "j.webp", size: MAX_UPLOAD_BYTES, mimeType: "image/webp" },
    ];
    expect((await ok("u1", files)).uploads).toHaveLength(10);
  });

  it("cleans the file name: control characters removed, spaces trimmed, Unicode kept", async () => {
    await ok("u1", [png("  photo\u0007 de café 🌅.png  ")]);
    expect((await prisma.upload.findFirstOrThrow({ where: { userId: "u1" } })).originalName).toBe("photo de café 🌅.png");
  });

  it("answers unavailable (and writes nothing) when the server has no Transloadit keys", async () => {
    await fixtures.user({ id: "u1" });
    await expect(createUploads("u1", [png()], { auth: null })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "Uploads aren't available right now." });
    expect(await prisma.upload.count()).toBe(0);
  });
});

describe("POST /api/uploads: refused before anything is written", () => {
  it.each([
    ["no files", { files: [] }, /at least one file/],
    ["11 files", { files: Array.from({ length: 11 }, (_, i) => png(`${i}.png`)) }, /at most 10 files/],
    ["an empty file", { files: [png("a.png", 0)] }, /empty/],
    ["a file over 500 MB", { files: [png("a.png", MAX_UPLOAD_BYTES + 1)] }, /at most 500 MB/],
    ["a PDF", { files: [{ name: "doc.pdf", size: 10, mimeType: "application/pdf" }] }, /Only images, videos and audio/],
    ["a type that doesn't match the name", { files: [{ name: "photo.png", size: 10, mimeType: "video/mp4" }] }, /doesn't match its type/],
    ["a name with no extension", { files: [{ name: "photo", size: 10, mimeType: "image/png" }] }, /doesn't match its type/],
    ["a blank name", { files: [png("   ")] }, /needs a name/],
    ["a name of only control characters", { files: [png("\u0000\u0001")] }, /needs a name/],
    ["a name over 255 characters", { files: [png(`${"x".repeat(252)}.png`)] }, /at most 255 characters/],
    ["a fractional size", { files: [png("a.png", 1.5)] }, /./],
    ["an unknown field", { files: [{ ...png(), path: "/etc/passwd" }] }, /./],
    ["a missing body", undefined, /./],
  ])("%s", async (_label, body, message) => {
    expect((await refused("u1", body)).error).toMatch(message);
    expect(await prisma.upload.count()).toBe(0);
  });

  it("refuses the whole request when any one file is bad", async () => {
    await refused("u1", { files: [png("ok.png"), png("bad.png", 0)] });
    expect(await prisma.upload.count()).toBe(0);
  });
});

describe("POST /api/uploads: the monthly allowance (shared by the whole app)", () => {
  const thisMonth = new Date();

  it("refuses, with when it resumes, once this month's uploads would pass 5 GB", async () => {
    await seedUploads("other", [{ size: MAX_UPLOAD_BYTES }, ...Array.from({ length: 9 }, () => ({ size: MAX_UPLOAD_BYTES - 100 }))]); // 5 GB - 900 bytes
    const error = await refused("u1", { files: [png("a.png", 1_000)] }, 429);
    expect(error.code).toBe("UPLOAD_LIMIT_REACHED");
    const next = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() + 1, 1));
    expect(error.error).toBe(`This month's upload allowance is used up. Uploads resume on ${next.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}.`);
    expect(await prisma.upload.count({ where: { userId: "u1" } })).toBe(0);
    // what still fits goes through
    await ok("u1", [png("small.png", 900)]);
  });

  it("doesn't count last month's uploads, failed uploads, or pending ones that can no longer start", async () => {
    const lastMonth = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth(), 1) - 1);
    const lapsed = new Date(Date.now() - 31 * 60_000);
    // a lapsed pending upload created this month: guaranteed as long as the month is over 31 minutes old
    const lapsedThisMonth = lapsed.getTime() >= Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth(), 1) ? lapsed : lastMonth;
    await seedUploads("other", [
      ...Array.from({ length: 10 }, () => ({ size: MAX_UPLOAD_BYTES, createdAt: lastMonth })),
      ...Array.from({ length: 10 }, () => ({ size: MAX_UPLOAD_BYTES, status: "FAILED" as const })),
      ...Array.from({ length: 10 }, () => ({ size: MAX_UPLOAD_BYTES, status: "PENDING" as const, createdAt: lapsedThisMonth })),
    ]);
    await ok("u1", [png("a.png", MAX_UPLOAD_BYTES)]);
  });

  it("counts pending uploads that can still start", async () => {
    await seedUploads("other", Array.from({ length: 10 }, () => ({ size: MAX_UPLOAD_BYTES, status: "PENDING" as const })));
    expect((await refused("u1", { files: [png()] }, 429)).code).toBe("UPLOAD_LIMIT_REACHED");
  });

  it("waits while another signer holds the allowance lock, so two can never both take the last of it", async () => {
    await fixtures.user({ id: "u1" });
    let releasedAt = 0;
    let holding!: () => void;
    const locked = new Promise<void>((resolve) => (holding = resolve));
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ALLOWANCE_LOCK})`;
      holding();
      await new Promise((resolve) => setTimeout(resolve, 600));
      releasedAt = Date.now();
    });
    await locked;
    await createUploads("u1", [png()], { auth: AUTH });
    const signedAt = Date.now();
    await holder;
    expect(signedAt).toBeGreaterThanOrEqual(releasedAt);
  });

  it("lets exactly one of two simultaneous requests take the last of the allowance", async () => {
    await seedUploads("other", Array.from({ length: 6 }, () => ({ size: MAX_UPLOAD_BYTES }))); // 3 GB used, 2 GB left
    const big = Array.from({ length: 3 }, (_, i) => png(`${i}.png`, MAX_UPLOAD_BYTES)); // 1.5 GB each request
    const [a, b] = await Promise.all([post("u1", { files: big }), post("u2", { files: big })]);
    expect([a.status, b.status].sort()).toEqual([201, 429]);
    const used = await prisma.upload.aggregate({ _count: true, where: { status: "PENDING" } });
    expect(used._count).toBe(3);
    expect(MONTHLY_UPLOAD_BYTES).toBe(5_000_000_000);
  });
});

describe("POST /api/uploads: uploads in flight per user", () => {
  it(`allows at most ${MAX_PENDING_UPLOADS} unfinished uploads per user`, async () => {
    await seedUploads("u1", Array.from({ length: MAX_PENDING_UPLOADS - 1 }, () => ({ size: 10, status: "PENDING" as const })));
    expect((await refused("u1", { files: [png("a.png"), png("b.png")] }, 429)).code).toBe("RATE_LIMITED");
    await ok("u1", [png("a.png")]); // exactly up to the cap
    await ok("u2", [png("a.png")]); // another user is unaffected
  });

  it("frees a slot once a pending upload's signature has lapsed", async () => {
    await seedUploads("u1", Array.from({ length: MAX_PENDING_UPLOADS }, () => ({ size: 10, status: "PENDING" as const, createdAt: new Date(Date.now() - 31 * 60_000) })));
    await ok("u1", [png()]);
  });
});

describe("the database's own rules for uploads, media and attachments", () => {
  async function violates(write: Promise<unknown>, constraint: string) {
    const error = await write.then(() => undefined, (e: unknown) => e);
    expect(String((error as Error)?.message)).toContain(constraint);
  }

  it("keeps file sizes between 1 byte and 0.5 GB", async () => {
    const user = await fixtures.user();
    for (const sizeBytes of [0, MAX_UPLOAD_BYTES + 1]) {
      await violates(prisma.upload.create({ data: { userId: user.id, originalName: "a.png", mimeType: "image/png", sizeBytes } }), "Upload_size_valid");
    }
  });

  it("won't mark an upload completed without its assembly", async () => {
    const user = await fixtures.user();
    await violates(prisma.upload.create({ data: { userId: user.id, originalName: "a.png", mimeType: "image/png", sizeBytes: 1, status: "COMPLETED" } }), "Upload_completed_has_assembly");
  });

  it("gives uploads, and only uploads, an expiry; and only http(s) links and positive dimensions", async () => {
    const user = await fixtures.user();
    const base = { userId: user.id, type: "IMAGE" as const, url: "https://example.com/a.png" };
    await violates(prisma.mediaAsset.create({ data: { ...base, source: "UPLOAD" } }), "MediaAsset_expiry_matches_source");
    await violates(prisma.mediaAsset.create({ data: { ...base, source: "GENERATED", expiresAt: new Date() } }), "MediaAsset_expiry_matches_source");
    await violates(prisma.mediaAsset.create({ data: { ...base, source: "GENERATED", url: "javascript:alert(1)" } }), "MediaAsset_url_http");
    await violates(prisma.mediaAsset.create({ data: { ...base, source: "GENERATED", width: 0 } }), "MediaAsset_dimensions_positive");
    await prisma.mediaAsset.create({ data: { ...base, source: "UPLOAD", expiresAt: new Date() } });
    await prisma.mediaAsset.create({ data: { ...base, source: "GENERATED", width: 10, height: 10 } });
  });

  it("orders a message's files 0-9, each file once, and removes them with the message", async () => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    const message = await fixtures.message(chat.id, user.id);
    const asset = (n: number) => prisma.mediaAsset.create({ data: { userId: user.id, source: "GENERATED", type: "IMAGE", url: `https://example.com/${n}.png` } });
    const [a, b] = [await asset(1), await asset(2)];
    await prisma.attachment.create({ data: { messageId: message.id, mediaAssetId: a.id, position: 0 } });
    await violates(prisma.attachment.create({ data: { messageId: message.id, mediaAssetId: b.id, position: 10 } }), "Attachment_position_valid");
    await violates(prisma.attachment.create({ data: { messageId: message.id, mediaAssetId: b.id, position: 0 } }), "Unique constraint");
    await violates(prisma.attachment.create({ data: { messageId: message.id, mediaAssetId: a.id, position: 1 } }), "Unique constraint");
    await prisma.message.delete({ where: { id: message.id } });
    expect(await prisma.attachment.count()).toBe(0);
    expect(await prisma.mediaAsset.count()).toBe(2); // the library keeps the files
  });
});
