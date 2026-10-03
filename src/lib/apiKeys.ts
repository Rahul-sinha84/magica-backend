import { createHash, randomBytes } from "node:crypto";
import { API_KEY_PREFIX } from "#src/contracts/index.js";

// How API keys look and are stored. A key is "mgc_" and 43 random base64url characters (256 bits); only its SHA-256
// hash is stored, so a database leak gives away no working keys. The first 12 characters are kept to show the user.

const SECRET_BYTES = 32;
export const API_KEY_PATTERN = /^mgc_[A-Za-z0-9_-]{43}$/;
const SHOWN = API_KEY_PREFIX.length + 8;

/** The stored form of a key. */
export const hashApiKey = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** A new key: the secret (shown once), the prefix the user sees afterwards, and the hash that is stored. */
export function generateApiKey(): { secret: string; prefix: string; hash: string } {
  const secret = `${API_KEY_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, SHOWN), hash: hashApiKey(secret) };
}
