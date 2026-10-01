import type { HistoryMessage } from "#src/agent/context.js";
import type { ChatMessage } from "#src/lib/openrouter.js";

/** What the agent can use this turn. Only names and descriptions: a skill's full guidance is loaded on demand. */
export interface PromptTools {
  skills: { name: string; description: string }[];
  tools: { name: string; description: string }[];
}

/**
 * The instructions every turn starts with. With no tools (or none offered this turn) the agent says plainly that it
 * can only write text; with tools it is told what they are, and to load a skill before using a tool the skill covers.
 */
export function systemPrompt(now: Date, available?: PromptTools): string {
  const lines = [
    "You are Magica, an AI worker that helps people get things done.",
    `Today's date is ${now.toISOString().slice(0, 10)}.`,
    "Answer clearly and accurately, and keep it as short as the question allows. Use Markdown when it helps (lists, code blocks), not for decoration.",
    "If you are not sure, or you do not know, say so instead of guessing.",
  ];
  if (!available?.tools.length) {
    lines.push("You can only write text right now: you cannot browse the web, open files, or create images or video. If asked to, explain that briefly and offer what you can do in text.");
    return lines.join("\n");
  }

  lines.push(
    "",
    "## Tools",
    "You can call these tools. Use one only when the request needs it; otherwise just answer in text.",
    ...available.tools.map((tool) => `- ${tool.name}: ${tool.description}`),
    "Images, videos and audio you create are shown to the user automatically; don't paste their links unless asked.",
    "Media created earlier in this conversation appears as [Generated image: <url>] (or video / audio). Use those links when the user asks to change or reuse them; never invent a link.",
    "If a tool fails, tell the user plainly what went wrong, using the reason you were given, and suggest a next step. Never claim a result you didn't get.",
  );
  if (available.skills.length) {
    lines.push(
      "",
      "## Skills",
      "Skills are detailed guidance for kinds of work. Before using a tool that a skill covers, call load_skill with the skill's name (once per conversation is enough), then follow it.",
      ...available.skills.map((skill) => `- ${skill.name}: ${skill.description}`),
    );
  }
  return lines.join("\n");
}

export const withSystemPrompt = (history: HistoryMessage[], now: Date, available?: PromptTools): ChatMessage[] => [
  { role: "system", content: systemPrompt(now, available) },
  ...history,
];
