import { z } from "zod";
import { CursorQuerySchema, IsoDateTimeSchema, NO_NUL_MESSAGE, noNul } from "./common.js";

export const MessageRoleSchema = z.enum(["USER", "ASSISTANT", "SYSTEM", "TOOL"]);

export const MessageStatusSchema = z.enum(["COMPLETED", "FAILED", "CANCELLED", "STREAMING"]);

export const TextBlockSchema = z.object({ type: z.literal("text"), content: z.string() });

export const ThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  content: z.string(),
  durationMs: z.number().optional(),
});

export const ReasoningBlockSchema = z.object({ type: z.literal("reasoning"), content: z.string() });

const AssetFields = {
  url: z.string(),
  mimeType: z.string().optional(),
  altText: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
};

export const ImageBlockSchema = z.object({ type: z.literal("image"), ...AssetFields });

export const VideoBlockSchema = z.object({ type: z.literal("video"), ...AssetFields });

export const AudioBlockSchema = z.object({ type: z.literal("audio"), ...AssetFields, durationMs: z.number().optional() });

export const ToolCallBlockSchema = z.object({
  type: z.literal("tool_call"),
  toolCallId: z.string(),
  toolName: z.string(),
  toolInput: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "running", "completed", "failed"]),
  durationMs: z.number().optional(),
  creditCost: z.number().optional(),
});

export const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  toolCallId: z.string(),
  toolName: z.string(),
  // optional: a failed tool may have no result, and JSONB drops undefined keys, so the stored block has none
  result: z.unknown().optional(),
  isError: z.boolean().default(false),
  errorMessage: z.string().optional(),
});

export const CitationBlockSchema = z.object({
  type: z.literal("citation"),
  // rendered as a link target, so only http(s) is allowed (blocks javascript: URLs)
  url: z.httpUrl(),
  title: z.string().optional(),
  snippet: z.string().optional(),
});

export const UsageBlockSchema = z.object({
  type: z.literal("usage"),
  inputTokens: z.number(),
  outputTokens: z.number(),
  model: z.string(),
  creditCost: z.number().optional(),
});

// Strict: used by the server to validate everything it persists.
export const ContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ThinkingBlockSchema,
  ReasoningBlockSchema,
  ImageBlockSchema,
  VideoBlockSchema,
  AudioBlockSchema,
  ToolCallBlockSchema,
  ToolResultBlockSchema,
  CitationBlockSchema,
  UsageBlockSchema,
]);

// Lenient: used when reading. One block we don't understand (for example a type added by a newer
// backend) must not blank the whole conversation, so invalid blocks are dropped instead of failing the parse.
export const ContentBlocksSchema = z.array(z.unknown()).transform((items) =>
  items.flatMap((item) => {
    const parsed = ContentBlockSchema.safeParse(item);
    if (parsed.success) return [parsed.data];
    console.warn("Dropped an unreadable content block", parsed.error.issues);
    return [];
  }),
);

export const MessageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: MessageRoleSchema,
  content: z.string().nullable(),
  contentBlocks: ContentBlocksSchema,
  status: MessageStatusSchema,
  createdAt: IsoDateTimeSchema,
  // the run this turn belongs to (both the user message that started it and the assistant reply)
  agentRunId: z.string().nullable().optional(),
  // chosen by the client when sending, so an optimistic message can be matched to its server copy
  clientMessageId: z.string().nullable().optional(),
  // why a reply failed, in words that are safe to show; null/absent on everything that did not fail
  errorMessage: z.string().nullable().optional(),
});

// The text is stored exactly as typed (indentation and code blocks matter), so it is only checked for
// being non-blank and NUL-free, never trimmed.
export const SendMessageBodySchema = z.strictObject({
  content: z
    .string()
    .max(32_000)
    .refine((text) => text.trim().length > 0, { error: "Message can't be empty." })
    .refine(noNul, { error: NO_NUL_MESSAGE }),
  attachments: z.array(z.httpUrl()).max(10).default([]),
  // lower-cased, so the same id in a different case can't slip past the server's duplicate check
  clientMessageId: z
    .uuid()
    .transform((id) => id.toLowerCase())
    .optional(),
});

export const SendMessageResponseSchema = z.object({
  message: MessageSchema,
  chatId: z.string(),
  // our AgentRun id
  runId: z.string(),
  // the Trigger.dev run id the realtime subscription needs
  triggerRunId: z.string(),
  realtimeToken: z.string(),
  realtimeTokenExpiresAt: IsoDateTimeSchema,
});

export const MessageListQuerySchema = CursorQuerySchema;

// Finished messages only: a reply that is still being generated is delivered by the run (see
// ActiveRunResponse), never by this list. `messages` are oldest to newest within the page. `cursor`
// fetches the next OLDER page and is null once the start of the conversation has been reached.
export const MessageListResponseSchema = z.object({
  messages: z.array(MessageSchema),
  cursor: z.string().nullable(),
});

export type Message = z.infer<typeof MessageSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type ToolCallBlock = z.infer<typeof ToolCallBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type ImageBlock = z.infer<typeof ImageBlockSchema>;
export type VideoBlock = z.infer<typeof VideoBlockSchema>;
export type AudioBlock = z.infer<typeof AudioBlockSchema>;
export type UsageBlock = z.infer<typeof UsageBlockSchema>;
export type SendMessageBody = z.infer<typeof SendMessageBodySchema>;
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;
