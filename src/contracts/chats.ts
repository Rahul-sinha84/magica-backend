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

export type Chat = z.infer<typeof ChatSchema>;
export type CreateChatBody = z.infer<typeof CreateChatBodySchema>;
export type UpdateChatBody = z.infer<typeof UpdateChatBodySchema>;
