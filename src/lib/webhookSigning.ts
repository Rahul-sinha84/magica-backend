import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

// Webhook secrets and signatures. Signatures follow Svix's scheme, so a receiver can verify them with the `svix`
// package (as the reference's docs show): HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<body>", keyed with the
// base64 part of the "whsec_…" secret, sent as "v1,<base64>". Secrets are stored encrypted (AES-256-GCM).

const PREFIX = "whsec_";

/** A new signing secret for an endpoint: "whsec_" and 32 random bytes in base64. */
export const generateSigningSecret = () => `${PREFIX}${randomBytes(32).toString("base64")}`;

/** The svix-signature header value for this message. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.slice(PREFIX.length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** Encrypts a secret for storage: "v1:<iv>:<tag>:<ciphertext>", each base64. */
export function encryptSecret(secret: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

/** The secret back from its stored form; throws if it was tampered with or the key is wrong. */
export function decryptSecret(stored: string, keyHex: string): string {
  const [version, iv, tag, ciphertext] = stored.split(":");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("not an encrypted webhook secret");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
