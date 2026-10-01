import { ContentBlocksSchema, type Chat, type Message } from "#src/contracts/index.js";
import type { Chat as ChatRow, Message as MessageRow } from "#src/generated/prisma/client.js";

export const serializeChat = (row: ChatRow): Chat => ({
  id: row.id,
  title: row.title,
  userId: row.userId,
  isPinned: row.isPinned,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  lastMessageAt: row.lastMessageAt.toISOString(),
});

/**
 * `agentRunId` is the run this turn belongs to: the one a user message started, or the one that produced a reply.
 * `errorMessage` is why that run failed (only ever given for a failed reply).
 */
export const serializeMessage = (row: MessageRow, agentRunId: string | null, errorMessage: string | null = null, canRetry = false): Message => ({
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
});
