import { z } from "zod";
import { prisma, Prisma } from "#src/db/client.js";
import type { Chat as ChatRow } from "#src/generated/prisma/client.js";
import type { ChatListQuerySchema, ChatListResponseSchema, ChatSearchQuery, UpdateChatBody } from "#src/contracts/index.js";
import { AppError } from "#src/lib/errors.js";
import { CursorTimestampSchema, IdSchema, decodeCursor, encodeCursor } from "#src/lib/cursor.js";
import { containsPattern } from "#src/lib/search.js";
import { cancelTriggerRun } from "#src/lib/trigger.js";
import { ACTIVE_STATUSES, finalizeRun } from "#src/services/runs.js";
import { serializeChat } from "#src/services/serialize.js";

type ChatListQuery = z.infer<typeof ChatListQuerySchema>;
type ChatListResponse = z.infer<typeof ChatListResponseSchema>;

const chatNotFound = () => new AppError("NOT_FOUND", "Chat not found.");
const isMissingRow = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";

/** An id that cannot exist (wrong length or characters) is simply not found. */
export const parseChatId = (value: unknown): string => {
  const id = IdSchema.safeParse(value);
  if (!id.success) throw chatNotFound();
  return id.data;
};

// the id inside a cursor is held to the same rule as any chat id, so nothing the database would reject can get through
const ChatCursorSchema = z.tuple([z.union([z.literal(0), z.literal(1)]), CursorTimestampSchema, IdSchema]);

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

const SearchCursorSchema = z.tuple([CursorTimestampSchema, IdSchema]);

export { containsPattern } from "#src/lib/search.js";

/**
 * The caller's chats whose title or any message contains `q` (ignoring case), most recent activity first, one entry per
 * chat. Both columns have trigram indexes, so a match is found through the index rather than by reading every message;
 * the message side is a semi-join (IN), which the planner can drive from that index.
 */
export async function searchChats(userId: string, { q, cursor, limit }: ChatSearchQuery, db: Pick<typeof prisma, "$queryRaw"> = prisma): Promise<ChatListResponse> {
  const after = cursor ? decodeCursor(cursor, SearchCursorSchema) : undefined;
  const pattern = containsPattern(q);
  const rows = await db.$queryRaw<ChatRow[]>`
    SELECT c."id", c."userId", c."title", c."isPinned", c."lastMessageAt", c."createdAt", c."updatedAt"
    FROM "Chat" c
    WHERE c."userId" = ${userId}
      AND (
        c."title" ILIKE ${pattern}
        OR c."id" IN (SELECT m."chatId" FROM "Message" m WHERE m."userId" = ${userId} AND m."content" ILIKE ${pattern})
      )
      ${after ? Prisma.sql`AND (c."lastMessageAt", c."id") < (${after[0].toISOString()}::timestamp(3), ${after[1]})` : Prisma.empty}
    ORDER BY c."lastMessageAt" DESC, c."id" DESC
    LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    chats: page.map(serializeChat),
    cursor: rows.length > limit && last ? encodeCursor([last.lastMessageAt.toISOString(), last.id]) : null,
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

/**
 * Deleting a chat first stops its agent (if one is running) and gives the credit hold back.
 *
 * The chat row is locked before looking for the run. A send takes a shared lock on the chat row to write its messages,
 * so either the send finishes first (and this sees and ends its run) or this finishes first (and the send fails as
 * "chat not found"). Without the lock a run created in between would be deleted along with the chat, with its
 * credits still held.
 */
export async function deleteChat(userId: string, chatId: string): Promise<void> {
  let running: { id: string; triggerRunId: string | null } | null = null;
  await prisma.$transaction(async (tx) => {
    const owned = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Chat" WHERE id = ${chatId} AND "userId" = ${userId} FOR UPDATE`;
    if (owned.length === 0) throw chatNotFound();
    running = await tx.agentRun.findFirst({ where: { chatId, status: { in: [...ACTIVE_STATUSES] } }, select: { id: true, triggerRunId: true } });
    if (running) await finalizeRun(running.id, { status: "CANCELLED" }, tx);
    await tx.chat.delete({ where: { id: chatId } });
  });
  const stopped = running as { triggerRunId: string | null } | null; // assigned inside the transaction callback
  if (stopped?.triggerRunId) await cancelTriggerRun(stopped.triggerRunId); // after the delete, so a slow Trigger.dev never blocks it
}
