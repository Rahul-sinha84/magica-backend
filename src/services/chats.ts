import { z } from "zod";
import { prisma, Prisma } from "#src/db/client.js";
import type { ChatListQuerySchema, ChatListResponseSchema, UpdateChatBody } from "#src/contracts/index.js";
import { AppError } from "#src/lib/errors.js";
import { CursorTimestampSchema, decodeCursor, encodeCursor } from "#src/lib/cursor.js";
import { serializeChat } from "#src/services/serialize.js";

type ChatListQuery = z.infer<typeof ChatListQuerySchema>;
type ChatListResponse = z.infer<typeof ChatListResponseSchema>;

const chatNotFound = () => new AppError("NOT_FOUND", "Chat not found.");
const isMissingRow = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";

/** Ids are cuids. Anything else (another length, NUL, unicode, path tricks) cannot exist, so it is simply not found. */
export const ChatIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const parseChatId = (value: unknown): string => {
  const id = ChatIdSchema.safeParse(value);
  if (!id.success) throw chatNotFound();
  return id.data;
};

// the id inside a cursor is held to the same rule as any chat id, so nothing the database would reject can get through
const ChatCursorSchema = z.tuple([z.union([z.literal(0), z.literal(1)]), CursorTimestampSchema, ChatIdSchema]);

/** The caller's chat, or 404. Another user's chat and a chat that does not exist are indistinguishable. */
export async function requireChat(userId: string, chatId: string) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) throw chatNotFound();
  return chat;
}

// Newest activity first, pinned chats above the rest. The order is total (id breaks ties), which is what makes the
// keyset below exact: the next page is precisely the rows that sort after the last one served.
const ORDER = [{ isPinned: "desc" }, { lastMessageAt: "desc" }, { id: "desc" }] as const;

function sortsAfter({ isPinned, lastMessageAt, id }: { isPinned: boolean; lastMessageAt: Date; id: string }): Prisma.ChatWhereInput[] {
  return [
    ...(isPinned ? [{ isPinned: false }] : []), // everything unpinned comes after the pinned block
    { isPinned, lastMessageAt: { lt: lastMessageAt } },
    { isPinned, lastMessageAt, id: { lt: id } },
  ];
}

// `db` is only replaced in tests, which run the real query through a client that records the SQL it sends.
export async function listChats(userId: string, { cursor, limit }: ChatListQuery, db: Pick<typeof prisma, "chat"> = prisma): Promise<ChatListResponse> {
  const after = cursor ? decodeCursor(cursor, ChatCursorSchema) : undefined;
  const rows = await db.chat.findMany({
    where: { userId, ...(after && { OR: sortsAfter({ isPinned: after[0] === 1, lastMessageAt: after[1], id: after[2] }) }) },
    orderBy: [...ORDER],
    take: limit + 1, // one extra row tells us whether another page exists
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    chats: page.map(serializeChat),
    cursor: rows.length > limit && last ? encodeCursor([last.isPinned ? 1 : 0, last.lastMessageAt.toISOString(), last.id]) : null,
  };
}

export const createChat = (userId: string, title?: string) => prisma.chat.create({ data: { userId, ...(title && { title }) } });

export async function updateChat(userId: string, chatId: string, data: UpdateChatBody) {
  try {
    return await prisma.chat.update({ where: { id: chatId, userId }, data }); // the owner check is part of the update itself
  } catch (error) {
    throw isMissingRow(error) ? chatNotFound() : error;
  }
}

// Phase 5 adds "stop the chat's active run and release its credit hold" before this delete.
export async function deleteChat(userId: string, chatId: string): Promise<void> {
  try {
    await prisma.chat.delete({ where: { id: chatId, userId } });
  } catch (error) {
    throw isMissingRow(error) ? chatNotFound() : error;
  }
}
