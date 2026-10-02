import { z } from "zod";
import { CursorQuerySchema, IsoDateTimeSchema, NO_NUL_MESSAGE, noNul } from "./common.js";

// Letters, numbers, punctuation or symbols (emoji included). Zero-width and bidi control characters alone would
// leave a blank, unclickable row in the sidebar.
const HAS_VISIBLE_CHARACTER = /[\p{L}\p{N}\p{P}\p{S}]/u;

const TitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(noNul, { error: NO_NUL_MESSAGE })
  .refine((title) => HAS_VISIBLE_CHARACTER.test(title), { error: "Title needs at least one visible character." });

export const ChatSchema = z.object({
  id: z.string(),
  title: z.string(),
  userId: z.string(),
  isPinned: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  // the server always sets it (a new chat starts at its creation time); nullable is kept for older clients
  lastMessageAt: IsoDateTimeSchema.nullable(),
  _count: z.object({ messages: z.number() }).optional(),
});

export const CreateChatBodySchema = z.strictObject({ title: TitleSchema.optional() });

export const UpdateChatBodySchema = z
  .strictObject({ title: TitleSchema.optional(), isPinned: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, { error: "Provide at least one field to update." });

export const ChatListQuerySchema = CursorQuerySchema;

export const ChatResponseSchema = z.object({ chat: ChatSchema });
export const CreateChatResponseSchema = ChatResponseSchema;

// Pinned chats first, then most recent activity. `cursor` fetches the next page and is null at the end.
export const ChatListResponseSchema = z.object({
  chats: z.array(ChatSchema),
  cursor: z.string().nullable(),
});

// Search over the caller's chat titles and message content, as typed: `%` and `_` are ordinary characters, and case is
// ignored. At least 3 characters, because shorter terms can't use the search index and would scan every message.
export const SEARCH_QUERY_MIN = 3;
export const SEARCH_QUERY_MAX = 100;
export const ChatSearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(SEARCH_QUERY_MIN, { error: `Type at least ${SEARCH_QUERY_MIN} characters to search.` })
    .max(SEARCH_QUERY_MAX)
    .refine(noNul, { error: NO_NUL_MESSAGE }),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// Matching chats, most recent activity first (one entry per chat, however many of its messages match). `cursor`
// fetches the next page of the same search and is null at the end.
export const ChatSearchResponseSchema = ChatListResponseSchema;

export type Chat = z.infer<typeof ChatSchema>;
export type CreateChatBody = z.infer<typeof CreateChatBodySchema>;
export type UpdateChatBody = z.infer<typeof UpdateChatBodySchema>;
export type ChatSearchQuery = z.infer<typeof ChatSearchQuerySchema>;
export type ChatSearchResponse = z.infer<typeof ChatSearchResponseSchema>;
