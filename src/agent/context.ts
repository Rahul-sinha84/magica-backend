import { prisma } from "#src/db/client.js";
import type { ChatMessage } from "#src/lib/openrouter.js";

// Long conversations must not make every turn slower and more expensive, and must never overflow the model's context.
// So the model sees the newest part of the conversation that fits: at most this many messages and this many characters.
export const CONTEXT_MESSAGE_LIMIT = 100;
export const CONTEXT_CHAR_BUDGET = 48_000;

/**
 * The conversation up to and including the message being answered, oldest first, as the model should read it.
 *
 * Only finished messages count: a failed or cancelled reply is partial and unreliable, and the reply being written is
 * not there yet. The cut-off is the question itself, so a retry sees exactly what the first attempt saw.
 */
export async function loadConversation(
  chatId: string,
  triggerMessageId: string,
  db: Pick<typeof prisma, "message"> = prisma,
): Promise<ChatMessage[]> {
  const trigger = await db.message.findUnique({ where: { id: triggerMessageId }, select: { createdAt: true, id: true, chatId: true } });
  if (!trigger || trigger.chatId !== chatId) return [];

  const rows = await db.message.findMany({
    where: {
      chatId,
      role: { in: ["USER", "ASSISTANT"] },
      status: "COMPLETED",
      content: { not: null },
      OR: [{ createdAt: { lt: trigger.createdAt } }, { createdAt: trigger.createdAt, id: { lte: trigger.id } }],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: CONTEXT_MESSAGE_LIMIT,
    select: { role: true, content: true },
  });

  // newest first until the budget runs out; the question itself (the first one) is always kept
  const kept: ChatMessage[] = [];
  let used = 0;
  for (const row of rows) {
    const content = row.content ?? "";
    if (kept.length > 0 && used + content.length > CONTEXT_CHAR_BUDGET) break;
    kept.push({ role: row.role === "USER" ? "user" : "assistant", content });
    used += content.length;
  }
  kept.reverse();

  // a conversation has to start with a person speaking, and some models insist that speakers alternate
  while (kept[0]?.role === "assistant") kept.shift();
  const merged: ChatMessage[] = [];
  for (const message of kept) {
    const last = merged[merged.length - 1];
    if (last?.role === message.role) last.content = `${last.content}\n\n${message.content}`;
    else merged.push({ ...message });
  }
  return merged;
}
