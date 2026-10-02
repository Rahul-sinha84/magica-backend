import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

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
export function signedAssembly(auth: TransloaditAuth, { uploadId, notifyUrl, now = new Date() }: { uploadId: string; notifyUrl?: string; now?: Date }) {
  const expiresAt = new Date(now.getTime() + SIGNATURE_LIFETIME_MS);
  const params = JSON.stringify({
    auth: { key: auth.key, expires: transloaditExpiry(expiresAt) },
    fields: { uploadId },
    steps: { ":original": { robot: "/upload/handle" } },
    // Transloadit tells the API itself when the assembly ends, so an upload completes even if the browser has gone
    ...(notifyUrl && { notify_url: notifyUrl }),
  });
  return { params, signature: signParams(params, auth.secret), expiresAt };
}

/** Transloadit's assembly ids: 32 lowercase hex characters. */
export const ASSEMBLY_ID = /^[0-9a-f]{32}$/;

/**
 * Whether a notification really came from our Transloadit account: the lowercase hex HMAC-SHA1 of the exact
 * `transloadit` field, keyed with the auth secret (Transloadit's webhook format), compared in constant time.
 */
export function verifyNotification(secret: string, payload: unknown, signature: unknown): boolean {
  if (typeof payload !== "string" || typeof signature !== "string" || !/^[0-9a-f]{40}$/.test(signature)) return false;
  const expected = createHmac("sha1", secret).update(payload, "utf8").digest();
  return timingSafeEqual(Buffer.from(signature, "hex"), expected);
}

/** What we read from an assembly's status. Everything else Transloadit sends is ignored. */
export const AssemblyStatusSchema = z.object({
  ok: z.string().optional(),
  error: z.string().optional(),
  assembly_id: z.string().optional(),
  start_date: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  uploads: z
    .array(
      z.object({
        mime: z.string().nullish(),
        type: z.string().nullish(),
        size: z.number().nullish(),
        ssl_url: z.string().nullish(),
        meta: z.object({ width: z.number().nullish(), height: z.number().nullish() }).nullish(),
      }),
    )
    .optional(),
});
export type AssemblyStatus = z.infer<typeof AssemblyStatusSchema>;

/** Transloadit's dates ("2026/10/02 10:33:07 GMT") as a Date, or undefined if it isn't one. */
export function parseTransloaditDate(value: string | undefined): Date | undefined {
  const parts = value && /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  if (!parts) return undefined;
  const [, y, mo, d, h, mi, se] = parts.map(Number) as [number, number, number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  // Date.UTC rolls impossible values over (month 13 becomes January); such a date isn't the one Transloadit meant
  const exact = date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d && date.getUTCHours() === h && date.getUTCMinutes() === mi && date.getUTCSeconds() === se;
  return exact ? date : undefined;
}

export const TRANSLOADIT_API = "https://api2.transloadit.com";
const MAX_STATUS_BYTES = 1_000_000;

export class TransloaditUnavailable extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "TransloaditUnavailable";
  }
}

export type FetchAssembly = (assemblyId: string) => Promise<AssemblyStatus | null>;

/**
 * An assembly's status from Transloadit's public status endpoint: null if Transloadit doesn't know it; throws
 * TransloaditUnavailable when it can't be asked (timeout, outage, an answer that isn't a status).
 */
export function createFetchAssembly({ baseUrl = TRANSLOADIT_API, timeoutMs = 10_000, fetchImpl = fetch } = {}): FetchAssembly {
  return async (assemblyId) => {
    if (!ASSEMBLY_ID.test(assemblyId)) return null;
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/assemblies/${assemblyId}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    } catch (error) {
      throw new TransloaditUnavailable(error instanceof Error ? error.message : String(error));
    }
    const text = await response.text();
    if (text.length > MAX_STATUS_BYTES) throw new TransloaditUnavailable("status too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new TransloaditUnavailable(`unreadable status (${response.status})`);
    }
    const status = AssemblyStatusSchema.safeParse(body);
    if (!status.success) throw new TransloaditUnavailable(`unexpected status shape (${response.status})`);
    if (response.status === 404 || status.data.error === "ASSEMBLY_NOT_FOUND") return null;
    if (response.status >= 500) throw new TransloaditUnavailable(`HTTP ${response.status}`);
    return status.data;
  };
}
