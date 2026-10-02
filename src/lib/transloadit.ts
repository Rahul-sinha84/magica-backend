import { createHmac } from "node:crypto";

// Transloadit's signature authentication: the browser uploads straight to Transloadit with parameters the API signed,
// so the auth secret never leaves the server. Pure (key, secret and clock are passed in), so it is easy to test.

export interface TransloaditAuth {
  key: string;
  secret: string;
}

/** How long a signature is honoured: long enough for a slow upload to start, short enough not to linger. */
export const SIGNATURE_LIFETIME_MS = 30 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, "0");

/** Transloadit's `auth.expires` format: `YYYY/MM/DD HH:mm:ss+00:00`, in UTC. */
export function transloaditExpiry(at: Date): string {
  return `${at.getUTCFullYear()}/${pad(at.getUTCMonth() + 1)}/${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}+00:00`;
}

/** `sha384:` + the HMAC-SHA384 of the exact params string, in hex: what Transloadit checks. */
export const signParams = (params: string, secret: string) => `sha384:${createHmac("sha384", secret).update(params).digest("hex")}`;

/**
 * Signed parameters for one file's assembly. Transloadit keeps the upload on its temporary storage, whose link is the
 * file's address (the `:original` step only, no export). `uploadId` travels in `fields`, which the signature covers,
 * so the result can be matched to its Upload row and nobody can claim someone else's.
 */
export function signedAssembly(auth: TransloaditAuth, { uploadId, now = new Date() }: { uploadId: string; now?: Date }) {
  const expiresAt = new Date(now.getTime() + SIGNATURE_LIFETIME_MS);
  const params = JSON.stringify({
    auth: { key: auth.key, expires: transloaditExpiry(expiresAt) },
    fields: { uploadId },
    steps: { ":original": { robot: "/upload/handle" } },
  });
  return { params, signature: signParams(params, auth.secret), expiresAt };
}
