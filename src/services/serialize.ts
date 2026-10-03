import { ContentBlocksSchema, type Chat, type Message, type MessageAttachment } from "#src/contracts/index.js";
import type { Chat as ChatRow, MediaAsset as MediaAssetRow, Message as MessageRow, Prisma } from "#src/generated/prisma/client.js";
import { serializeMediaAsset } from "#src/services/media.js";

export const serializeChat = (row: ChatRow): Chat => ({
  id: row.id,
  title: row.title,
  userId: row.userId,
  isPinned: row.isPinned,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  lastMessageAt: row.lastMessageAt.toISOString(),
});

/** Loads a message's files with it, in order: `include: WITH_ATTACHMENTS`. */
export const WITH_ATTACHMENTS = { attachments: { orderBy: { position: "asc" }, include: { mediaAsset: true } } } as const satisfies Prisma.MessageInclude;

interface AttachmentRow {
  position: number;
  mediaAsset: MediaAssetRow;
}

/** A message's files, in order, each marked expired once its upload is past its lifetime. */
export const serializeAttachments = (rows: readonly AttachmentRow[], now = new Date()): MessageAttachment[] =>
  [...rows]
    .sort((a, b) => a.position - b.position)
    .map(({ mediaAsset }) => ({ ...serializeMediaAsset(mediaAsset), expired: mediaAsset.expiresAt !== null && mediaAsset.expiresAt.getTime() <= now.getTime() }));

/**
 * `agentRunId` is the run this turn belongs to: the one a user message started, or the one that produced a reply.
 * `errorMessage` is why that run failed (only ever given for a failed reply).
 */
export const serializeMessage = (row: MessageRow & { attachments?: readonly AttachmentRow[] }, agentRunId: string | null, errorMessage: string | null = null, canRetry = false): Message => ({
  id: row.id,
  chatId: row.chatId,
  role: row.role,
  content: row.content,
  // the column is JSON, so whatever is in it is read the way the client reads it: bad blocks dropped, never a crash
  contentBlocks: ContentBlocksSchema.parse(Array.isArray(row.contentBlocks) ? row.contentBlocks : []),
  status: row.status,
  createdAt: row.createdAt.toISOString(),
  agentRunId,
  clientMessageId: row.clientMessageId,
  errorMessage,
  canRetry,
  ...(row.attachments?.length ? { attachments: serializeAttachments(row.attachments) } : {}),
});
