import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SIGNATURE_LIFETIME_MS, signParams, signedAssembly, transloaditExpiry } from "#src/lib/transloadit.js";

const auth = { key: "test-key", secret: "test-secret" };
const now = new Date("2026-10-02T23:45:30.123Z");

describe("transloaditExpiry", () => {
  it("is YYYY/MM/DD HH:mm:ss+00:00 in UTC, zero-padded", () => {
    expect(transloaditExpiry(new Date("2026-01-05T03:04:05.999Z"))).toBe("2026/01/05 03:04:05+00:00");
  });
});

describe("signedAssembly", () => {
  const signed = signedAssembly(auth, { uploadId: "up_1", now });
  const params = JSON.parse(signed.params) as { auth: { key: string; expires: string }; fields: Record<string, string>; steps: Record<string, unknown> };

  it("expires 30 minutes from now (crossing midnight correctly)", () => {
    expect(SIGNATURE_LIFETIME_MS).toBe(30 * 60_000);
    expect(signed.expiresAt.toISOString()).toBe("2026-10-03T00:15:30.123Z");
    expect(params.auth).toEqual({ key: "test-key", expires: "2026/10/03 00:15:30+00:00" });
  });

  it("carries our upload id in the signed fields, and only keeps the original (no export)", () => {
    expect(params.fields).toEqual({ uploadId: "up_1" });
    expect(params.steps).toEqual({ ":original": { robot: "/upload/handle" } });
  });

  it("signs the exact params string with HMAC-SHA384 of the secret", () => {
    expect(signed.signature).toBe(`sha384:${createHmac("sha384", "test-secret").update(signed.params).digest("hex")}`);
    expect(signed.signature).toBe(signParams(signed.params, "test-secret"));
    expect(signParams(`${signed.params} `, "test-secret")).not.toBe(signed.signature); // any change breaks it
  });

  it("never puts the secret in what the browser receives", () => {
    expect(signed.params).not.toContain("test-secret");
    expect(signed.signature).not.toContain("test-secret");
  });
});
