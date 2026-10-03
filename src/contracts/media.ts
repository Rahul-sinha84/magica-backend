import { z } from "zod";
import { SEARCH_QUERY_MIN } from "./chats.js";
import { CursorQuerySchema, IsoDateTimeSchema, NO_NUL_MESSAGE, noNul } from "./common.js";

// The user's media library: files they uploaded and media the agent made for them. An upload lives on Transloadit's
// temporary storage, so it expires (`expiresAt`); generated media lives on Magica's CDN and doesn't.
export const MediaAssetSchema = z.object({
  id: z.string(),
  source: z.enum(["upload", "generated"]),
  type: z.enum(["image", "video", "audio"]),
  url: z.string(),
  // the file name, for uploads
  name: z.string().nullable(),
  // what the agent was asked to make, and the model that made it, for generated media
  prompt: z.string().nullable(),
  model: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  mimeType: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  // uploads only: after this the file is gone; null for generated media
  expiresAt: IsoDateTimeSchema.nullable(),
});

// An empty search box sends `q=`; that means "no search", not "search for nothing".
const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

export const MediaListQuerySchema = CursorQuerySchema.extend({
  source: z.enum(["upload", "generated"]).optional(),
  // file names and prompts; like chat search, at least SEARCH_QUERY_MIN characters so the index can serve it
  q: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .min(SEARCH_QUERY_MIN, { error: `Type at least ${SEARCH_QUERY_MIN} characters to search.` })
      .max(100)
      .refine(noNul, { error: NO_NUL_MESSAGE })
      .optional(),
  ),
});

// Newest first; expired uploads are left out. `total` is how many files the library holds (all sources, unexpired),
// for the header ("30 files"); `cursor` fetches the next page of the same list and is null at the end.
export const MediaListResponseSchema = z.object({
  media: z.array(MediaAssetSchema),
  cursor: z.string().nullable(),
  total: z.number().int(),
});

export type MediaAsset = z.infer<typeof MediaAssetSchema>;
export type MediaListQuery = z.infer<typeof MediaListQuerySchema>;
export type MediaListResponse = z.infer<typeof MediaListResponseSchema>;
