import { ContentBlocksSchema, blocksToText, type ContentBlock } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";

// Long conversations must not make every turn slower and more expensive, and must never overflow the model's context.
// So the model sees the newest part of the conversation that fits: at most this many messages and this many characters.
export const CONTEXT_MESSAGE_LIMIT = 100;
export const CONTEXT_CHAR_BUDGET = 48_000;

/** One earlier message, as the model reads it. */
export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

const MEDIA_LABEL = { image: "image", video: "video", audio: "audio" } as const;

/**
 * What the model is told about an earlier reply. Its text (only if it finished: a failed or stopped reply's partial
 * text is unreliable), every image, video or audio it produced (so "crop the image" knows which one, even if the turn
 * failed later), and which tool calls failed and why. Thinking, usage and successful tool details are left out.
 */
export function renderReply(blocks: ContentBlock[], fallbackText: string | null, finished: boolean): string {
  const lines: string[] = [];
  const text = blocks.length > 0 ? blocksToText(blocks) : (fallbackText ?? "");
  if (finished && text.trim()) lines.push(text.trim());
  for (const block of blocks) {
    if (block.type === "image" || block.type === "video" || block.type === "audio") lines.push(`[Generated ${MEDIA_LABEL[block.type]}: ${block.url}]`);
    else if (block.type === "tool_result" && block.isError) lines.push(`[${block.toolName} failed: ${block.errorMessage ?? "no reason given"}]`);
  }
  return lines.join("\n");
}

/**
 * What the model is told about a user's message: its text, then one line per attached file, in order. A file that has
 * expired gets a line without a link, so the model knows it was there but can't hand a dead link to a tool (the tools
 * only accept links that appear in the conversation).
 */
export function renderQuestion(text: string | null, files: readonly { type: "IMAGE" | "VIDEO" | "AUDIO"; url: string; expiresAt: Date | null }[], now = new Date()): string {
  const lines = text?.trim() ? [text] : [];
  for (const file of files) {
    const label = MEDIA_LABEL[file.type === "IMAGE" ? "image" : file.type === "VIDEO" ? "video" : "audio"];
    lines.push(file.expiresAt && file.expiresAt.getTime() <= now.getTime() ? `[Attached ${label} (expired)]` : `[Attached ${label}: ${file.url}]`);
  }
  return lines.join("\n");
}

/**
 * The conversation up to and including the message being answered, oldest first, as the model should read it.
 *
 * The cut-off is the question itself, so a retry sees exactly what the first attempt saw. The reply being written is
 * never included; earlier replies are rendered by renderReply.
 */
export async function loadConversation(
  chatId: string,
  triggerMessageId: string,
  db: Pick<typeof prisma, "message"> = prisma,
  now = new Date(),
): Promise<HistoryMessage[]> {
  const trigger = await db.message.findUnique({ where: { id: triggerMessageId }, select: { createdAt: true, id: true, chatId: true } });
  if (!trigger || trigger.chatId !== chatId) return [];

  const rows = await db.message.findMany({
    where: {
      chatId,
      OR: [
        { role: "USER", status: "COMPLETED" },
        { role: "ASSISTANT", status: { in: ["COMPLETED", "FAILED", "CANCELLED"] } },
      ],
      AND: [{ OR: [{ createdAt: { lt: trigger.createdAt } }, { createdAt: trigger.createdAt, id: { lte: trigger.id } }] }],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: CONTEXT_MESSAGE_LIMIT,
    select: {
      role: true,
      status: true,
      content: true,
      contentBlocks: true,
      attachments: { orderBy: { position: "asc" }, select: { mediaAsset: { select: { type: true, url: true, expiresAt: true } } } },
    },
  });

  // newest first until the budget runs out; the question itself (the first one) is always kept
  const kept: HistoryMessage[] = [];
  let used = 0;
  for (const row of rows) {
    const content =
      row.role === "USER"
        ? renderQuestion(row.content, row.attachments.map((file) => file.mediaAsset), now)
        : renderReply(ContentBlocksSchema.parse(Array.isArray(row.contentBlocks) ? row.contentBlocks : []), row.content, row.status === "COMPLETED");
    if (!content.trim()) continue; // nothing the model could use (an empty or text-only failed reply)
    if (kept.length > 0 && used + content.length > CONTEXT_CHAR_BUDGET) break;
    kept.push({ role: row.role === "USER" ? "user" : "assistant", content });
    used += content.length;
  }
  kept.reverse();

  // a conversation has to start with a person speaking, and some models insist that speakers alternate
  while (kept[0]?.role === "assistant") kept.shift();
  const merged: HistoryMessage[] = [];
  for (const message of kept) {
    const last = merged[merged.length - 1];
    if (last?.role === message.role) last.content = `${last.content}\n\n${message.content}`;
    else merged.push({ ...message });
  }
  return merged;
}
