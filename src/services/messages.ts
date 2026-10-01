import { z } from "zod";
import type { Message, MessageListQuerySchema, MessageListResponseSchema } from "#src/contracts/index.js";
import { prisma, type Prisma } from "#src/db/client.js";
import { CursorTimestampSchema, IdSchema, decodeCursor, encodeCursor } from "#src/lib/cursor.js";
import { requireChat } from "#src/services/chats.js";
import { RETRYABLE_STATUSES } from "#src/services/runs.js";
import { serializeMessage } from "#src/services/serialize.js";

type MessageListQuery = z.infer<typeof MessageListQuerySchema>;
type MessageListResponse = z.infer<typeof MessageListResponseSchema>;

const MessageCursorSchema = z.tuple([CursorTimestampSchema, IdSchema]);

/**
 * One page of finished messages, newest page first; inside a page they run oldest to newest, which is how they are
 * read. A reply that is still being written is not in this list: the run delivers it (see `active-run`).
 * `db` is only replaced in tests, which run the real query through a client that records the SQL it sends.
 */
export async function listMessages(
  userId: string,
  chatId: string,
  { cursor, limit }: MessageListQuery,
  db: Pick<typeof prisma, "message" | "agentRun"> = prisma,
): Promise<MessageListResponse> {
  await requireChat(userId, chatId);
  const after = cursor ? decodeCursor(cursor, MessageCursorSchema) : undefined;
  const where: Prisma.MessageWhereInput = {
    chatId,
    status: { not: "STREAMING" },
    ...(after && { OR: [{ createdAt: { lt: after[0] } }, { createdAt: after[0], id: { lt: after[1] } }] }),
  };
  const rows = await db.message.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1 });
  const page = rows.slice(0, limit);
  const oldest = page[page.length - 1];

  // the run each message belongs to: a reply's own run, or the latest run a user message started
  const ids = page.map((m) => m.id);
  const runs = await db.agentRun.findMany({
    where: { OR: [{ assistantMessageId: { in: ids } }, { triggerMessageId: { in: ids } }] },
    select: { id: true, assistantMessageId: true, triggerMessageId: true, createdAt: true, errorMessage: true },
    orderBy: { createdAt: "asc" }, // later runs overwrite earlier ones below
  });
  // only the chat's latest turn can be retried, and only once it failed or was stopped (see retryRun)
  const latest = await db.agentRun.findFirst({ where: { chatId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, status: true } });
  const retryable = latest && RETRYABLE_STATUSES.includes(latest.status) ? latest.id : null;

  const runOf = new Map<string, string>();
  const failureOf = new Map<string, string>();
  for (const run of runs) {
    runOf.set(run.triggerMessageId, run.id);
    runOf.set(run.assistantMessageId, run.id);
    if (run.errorMessage) failureOf.set(run.assistantMessageId, run.errorMessage);
  }

  // the reason is only ever shown on a reply that actually failed
  const messages: Message[] = page
    .reverse()
    .map((row) => {
      const runId = runOf.get(row.id) ?? null;
      const canRetry = row.role === "ASSISTANT" && runId !== null && runId === retryable;
      return serializeMessage(row, runId, row.status === "FAILED" ? (failureOf.get(row.id) ?? null) : null, canRetry);
    });
  return { messages, cursor: rows.length > limit && oldest ? encodeCursor([oldest.createdAt.toISOString(), oldest.id]) : null };
}
