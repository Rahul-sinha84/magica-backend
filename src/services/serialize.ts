import type { Chat } from "#src/contracts/index.js";
import type { Chat as ChatRow } from "#src/generated/prisma/client.js";

export const serializeChat = (row: ChatRow): Chat => ({
  id: row.id,
  title: row.title,
  userId: row.userId,
  isPinned: row.isPinned,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  lastMessageAt: row.lastMessageAt.toISOString(),
});
