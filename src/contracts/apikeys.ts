import { z } from "zod";
import { IsoDateTimeSchema, NO_NUL_MESSAGE, noNul } from "./common.js";

// Keys for the public API (/v1). A key is shown once, when it is created; after that only its prefix is.

/** Every key starts with this, so it is never mistaken for a real Magica key (those start with gx_). */
export const API_KEY_PREFIX = "mgc_";
/** Keys a user may have working at once (expired and revoked keys don't count). */
export const MAX_ACTIVE_API_KEYS = 10;
/** Requests a key may make, per minute and per day (as in the reference docs). */
export const API_KEY_LIMITS = {
  perMinute: { min: 1, max: 10_000, default: 60 },
  perDay: { min: 1, max: 100_000, default: 1_000 },
} as const;

// active: it works. expired: past its expiry. Revoked keys aren't listed.
export const ApiKeyStatusSchema = z.enum(["active", "expired"]);

export const ApiKeySchema = z.object({
  id: z.string(),
  label: z.string(),
  // the key's first characters ("mgc_Ab12Cd34"), so the user can tell their keys apart
  prefix: z.string(),
  perMinute: z.int(),
  perDay: z.int(),
  status: ApiKeyStatusSchema,
  expiresAt: IsoDateTimeSchema.nullable(),
  lastUsedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});

const LabelSchema = z
  .string()
  .trim()
  .min(1, { error: "Give the key a name." })
  .max(64, { error: "A key's name can be at most 64 characters." })
  .refine(noNul, { error: NO_NUL_MESSAGE });
const PerMinuteSchema = z.int().min(API_KEY_LIMITS.perMinute.min).max(API_KEY_LIMITS.perMinute.max);
const PerDaySchema = z.int().min(API_KEY_LIMITS.perDay.min).max(API_KEY_LIMITS.perDay.max);

// POST /api/api-keys. `expiresAt` must be in the future; leave it out (or null) for a key that never expires.
export const CreateApiKeyBodySchema = z.strictObject({
  label: LabelSchema,
  perMinute: PerMinuteSchema.default(API_KEY_LIMITS.perMinute.default),
  perDay: PerDaySchema.default(API_KEY_LIMITS.perDay.default),
  expiresAt: IsoDateTimeSchema.nullable().optional(),
});

// `secret` is the key itself: shown once, never again (only its hash is kept).
export const CreateApiKeyResponseSchema = z.object({ apiKey: ApiKeySchema, secret: z.string().startsWith(API_KEY_PREFIX) });

// Newest first. `activeCount` out of `maxActive` is the "n/10" counter.
export const ApiKeyListResponseSchema = z.object({
  apiKeys: z.array(ApiKeySchema),
  activeCount: z.int(),
  maxActive: z.int(),
});

// PATCH /api/api-keys/{id}: rename it, or change its limits.
export const UpdateApiKeyBodySchema = z
  .strictObject({ label: LabelSchema.optional(), perMinute: PerMinuteSchema.optional(), perDay: PerDaySchema.optional() })
  .refine((body) => body.label !== undefined || body.perMinute !== undefined || body.perDay !== undefined, { error: "Nothing to change." });

export const ApiKeyResponseSchema = z.object({ apiKey: ApiKeySchema });

export type ApiKey = z.infer<typeof ApiKeySchema>;
export type ApiKeyStatus = z.infer<typeof ApiKeyStatusSchema>;
export type CreateApiKeyBody = z.infer<typeof CreateApiKeyBodySchema>;
export type CreateApiKeyResponse = z.infer<typeof CreateApiKeyResponseSchema>;
export type ApiKeyListResponse = z.infer<typeof ApiKeyListResponseSchema>;
export type UpdateApiKeyBody = z.infer<typeof UpdateApiKeyBodySchema>;
export type ApiKeyResponse = z.infer<typeof ApiKeyResponseSchema>;
