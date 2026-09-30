import { prisma } from "#src/db/client.js";
import { env } from "#src/env/base.js";
import { assertTestDatabase } from "./guard.js";

const TABLES = ["CreditLedger", "ToolInvocation", "AgentRun", "Message", "Chat", "User"] as const;

export async function resetDb(): Promise<void> {
  assertTestDatabase(env.DATABASE_URL);
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

let counter = 0;
const uid = (prefix: string) => `${prefix}_${++counter}`;

/** Minimal valid rows, so each test only spells out what it cares about. */
export const fixtures = {
  user: (overrides: Partial<{ id: string; balance: number; held: number }> = {}) =>
    prisma.user.create({ data: { id: uid("user"), balance: 1_000_000, ...overrides } }),

  chat: (userId: string) => prisma.chat.create({ data: { userId } }),

  message: (chatId: string, userId: string, overrides: Partial<{ role: "USER" | "ASSISTANT"; clientMessageId: string }> = {}) =>
    prisma.message.create({ data: { chatId, userId, role: "USER", ...overrides } }),

  /** A run needs a trigger message and an assistant message; this creates all three rows. */
  async run(chatId: string, userId: string, status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" = "PENDING") {
    const trigger = await fixtures.message(chatId, userId);
    const assistant = await fixtures.message(chatId, userId, { role: "ASSISTANT" });
    return prisma.agentRun.create({
      data: {
        chatId,
        userId,
        triggerMessageId: trigger.id,
        assistantMessageId: assistant.id,
        status,
        traceId: uid("trace"),
      },
    });
  },
};
