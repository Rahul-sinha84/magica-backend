import { CreateChatBodySchema } from "#src/contracts/index.js";
import { wellFormed } from "#src/lib/text.js";

/** What the database gives a chat until something names it (see the Chat model). */
export const DEFAULT_CHAT_TITLE = "New chat";

/**
 * A chat title made from free text (a first message, a model's answer): whitespace collapsed, cut at `max`
 * characters (whole characters, never half an emoji) with an ellipsis, and checked against the same rules as a title
 * a user types. Returns null when nothing usable is left, so the caller keeps the current title.
 */
export function titleFrom(text: string, max: number): string | null {
  const collapsed = wellFormed(text).replaceAll("\u0000", "").replace(/\s+/g, " ").trim();
  const characters = Array.from(collapsed);
  const title = characters.length > max ? `${characters.slice(0, max).join("").trimEnd()}…` : collapsed;
  const valid = CreateChatBodySchema.shape.title.safeParse(title);
  return valid.success && valid.data ? valid.data : null;
}
