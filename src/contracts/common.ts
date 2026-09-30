import { z } from "zod";

// Accepts both "…Z" and "…+05:30", so a change in the backend's date serialiser can't break every screen.
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

// Stable, machine-readable failure reasons. The HTTP status says how bad, the code says which.
export const ErrorCodeSchema = z.enum([
  "UNAUTHORIZED", // 401
  "VALIDATION_FAILED", // 400
  "NOT_FOUND", // 404 (also used for other users' resources, so nothing leaks)
  "RUN_ACTIVE", // 409: the chat already has a run in flight
  "INSUFFICIENT_CREDITS", // 402
  "PAYLOAD_TOO_LARGE", // 413
  "RATE_LIMITED", // 429
  "SERVICE_UNAVAILABLE", // 503
  "INTERNAL_ERROR", // 500
]);

// `error` stays a plain user-safe string so simple clients can show it as-is.
export const ErrorResponseSchema = z.object({
  error: z.string(),
  code: ErrorCodeSchema,
  details: z.record(z.string(), z.unknown()).optional(),
});

// Postgres text and JSONB cannot store a NUL character, so it is rejected up front instead of failing as a 500 at insert time.
export const noNul = (text: string) => !text.includes("\u0000");
export const NO_NUL_MESSAGE = "Text can't contain null characters.";

// Query string for every paginated list. `cursor` is opaque: clients only pass back what the server gave them.
export const CursorQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type CursorQuery = z.infer<typeof CursorQuerySchema>;
