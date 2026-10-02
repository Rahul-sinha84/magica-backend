import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateSigningSecret, signWebhook } from "#src/lib/webhookSigning.js";
import { isBlockedAddress, webhookUrlProblem } from "#src/lib/webhookUrl.js";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("webhook secrets", () => {
  it("are whsec_ and 32 random bytes, different every time", () => {
    const [a, b] = [generateSigningSecret(), generateSigningSecret()];
    expect(a).toMatch(/^whsec_/);
    expect(Buffer.from(a.slice(6), "base64")).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it("round-trip through encryption, and refuse a tampered copy or the wrong key", () => {
    const secret = generateSigningSecret();
    const stored = encryptSecret(secret, KEY);
    expect(stored).not.toContain(secret.slice(6));
    expect(decryptSecret(stored, KEY)).toBe(secret);
    expect(encryptSecret(secret, KEY)).not.toBe(stored); // a fresh nonce each time
    const [version, iv, tag, ciphertext] = stored.split(":");
    const flipped = Buffer.from(ciphertext!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptSecret([version, iv, tag, flipped.toString("base64")].join(":"), KEY)).toThrow();
    expect(() => decryptSecret(stored, "f".repeat(64))).toThrow();
    expect(() => decryptSecret("plaintext", KEY)).toThrow();
  });

  it("sign the way Svix does: v1, base64 HMAC-SHA256 of id.timestamp.body", () => {
    const secret = `whsec_${Buffer.from("k".repeat(32)).toString("base64")}`;
    expect(signWebhook(secret, "msg_1", 1_700_000_000, '{"a":1}')).toBe(signWebhook(secret, "msg_1", 1_700_000_000, '{"a":1}'));
    expect(signWebhook(secret, "msg_1", 1_700_000_000, '{"a":1}')).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/);
    expect(signWebhook(secret, "msg_1", 1_700_000_001, '{"a":1}')).not.toBe(signWebhook(secret, "msg_1", 1_700_000_000, '{"a":1}'));
  });
});

describe("webhook addresses", () => {
  it.each(["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "not-an-ip"])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])("allows the public address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("allows http://localhost only while developing", () => {
    expect(webhookUrlProblem("http://localhost:4000/hook", { allowLocalhost: true })).toBeNull();
    expect(webhookUrlProblem("http://localhost:4000/hook", { allowLocalhost: false })).toBe("must use https");
    expect(webhookUrlProblem("https://localhost/hook", { allowLocalhost: false })).toBe("must be a public address");
    expect(webhookUrlProblem("https://[::1]/hook", { allowLocalhost: false })).toBe("must be a public address");
    expect(webhookUrlProblem("https://example.com/hook", { allowLocalhost: false })).toBeNull();
    expect(webhookUrlProblem(`https://example.com/${"x".repeat(2050)}`, { allowLocalhost: false })).toBe("must be at most 2048 characters");
  });
});
