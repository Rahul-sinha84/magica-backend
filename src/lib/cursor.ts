import { z } from "zod";
import { AppError } from "#src/lib/errors.js";

// Pagination cursors are opaque to clients: base64url of a small JSON tuple holding the sort key of the last row
// served. A client can only hand one back, and a forged one can only change where in *its own* rows the next page
// starts (every query is also scoped to the caller), so it is validated strictly but needs no signature.

/** Ids are cuids. Anything else (another length, NUL, unicode, path tricks) cannot exist in the database. */
export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const encodeCursor = (payload: readonly unknown[]): string => Buffer.from(JSON.stringify(payload)).toString("base64url");

/** A timestamp from a cursor. Bounded, because the database rejects dates such as year 0000 (a 500 otherwise). */
export const CursorTimestampSchema = z
  .iso.datetime()
  .refine((value) => {
    const year = new Date(value).getUTCFullYear();
    return year >= 2000 && year < 2200;
  })
  .transform((value) => new Date(value));

/** Decodes and validates a cursor; anything malformed, truncated or tampered with is a 400, never a 500. */
export function decodeCursor<S extends z.ZodType>(cursor: string, schema: S): z.output<S> {
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new AppError("VALIDATION_FAILED", "cursor: That page marker isn't valid. Start again from the first page.", {
      fields: { cursor: ["Invalid cursor."] },
    });
  }
}
