import type { ChatMessage } from "#src/lib/openrouter.js";

/**
 * The instructions every turn starts with. Kept here, in one place, because this is where tool and skill descriptions
 * are added later; for now the agent only writes text, and says so plainly when asked for more.
 */
export function systemPrompt(now: Date): string {
  return [
    "You are Magica, an AI worker that helps people get things done.",
    `Today's date is ${now.toISOString().slice(0, 10)}.`,
    "Answer clearly and accurately, and keep it as short as the question allows. Use Markdown when it helps (lists, code blocks), not for decoration.",
    "If you are not sure, or you do not know, say so instead of guessing.",
    "You can only write text right now: you cannot browse the web, open files, or create images or video. If asked to, explain that briefly and offer what you can do in text.",
  ].join("\n");
}

export const withSystemPrompt = (history: ChatMessage[], now: Date): ChatMessage[] => [
  { role: "system", content: systemPrompt(now) },
  ...history,
];
