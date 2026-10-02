import { clearUserCache } from "#src/auth/users.js";
import { prisma, type Prisma } from "#src/db/client.js";
import { holdKey } from "#src/lib/idempotency.js";
import { hold } from "#src/services/credits.js";
import { env } from "#src/env/base.js";
import { resetClerkMock } from "./clerkMock.js";
import { resetTriggerMock } from "./triggerMock.js";
import { assertTestDatabase } from "./guard.js";

const TABLES = ["IdempotencyRecord", "ApiKey", "Waitpoint", "Attachment", "Upload", "MediaAsset", "CreditLedger", "ToolInvocation", "RunSkill", "AgentRun", "Message", "Chat", "User"] as const;

export async function resetDb(): Promise<void> {
  assertTestDatabase(env.DATABASE_URL);
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  clearUserCache(); // the users it remembered no longer exist
  resetClerkMock();
  resetTriggerMock();
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

export interface TurnFixture {
  status?: "PENDING" | "RUNNING";
  triggerRunId?: string | null;
  /** How long ago the run was created, and how long ago its partial reply was last saved. */
  ageMs?: number;
  quietMs?: number;
  blocks?: unknown[];
  content?: string;
  heldCredits?: number;
  startedAt?: Date | null;
}

/** A send that is in flight, written straight to the database: messages, an active run and its credit hold. */
export async function activeTurn(chatId: string, userId: string, options: TurnFixture = {}) {
  const { status = "RUNNING", triggerRunId = `run_${Math.random().toString(36).slice(2, 10)}`, ageMs = 5_000, quietMs = 1_000, blocks = [], heldCredits = 100_000 } = options;
  const createdAt = new Date(Date.now() - ageMs);
  const updatedAt = new Date(Date.now() - quietMs);
  const userMessage = await prisma.message.create({ data: { chatId, userId, role: "USER", content: "hello", createdAt } });
  const assistantMessage = await prisma.message.create({
    data: {
      chatId,
      userId,
      role: "ASSISTANT",
      status: "STREAMING",
      contentBlocks: blocks as Prisma.InputJsonValue,
      content: options.content ?? null,
      createdAt: new Date(createdAt.getTime() + 1),
      updatedAt,
    },
  });
  const run = await prisma.agentRun.create({
    data: {
      chatId,
      userId,
      triggerMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      status,
      triggerRunId,
      traceId: "trace_fixture",
      createdAt,
      startedAt: options.startedAt === undefined ? (status === "RUNNING" ? createdAt : null) : options.startedAt,
    },
  });
  if (heldCredits > 0) {
    await prisma.$transaction((tx) => hold(tx, { userId, amount: heldCredits, reason: "fixture hold", idempotencyKey: holdKey(run.id), agentRunId: run.id }));
  }
  // `updatedAt` is managed by the database layer, so pin it after the fact to simulate a reply not saved for a while
  await prisma.$executeRaw`UPDATE "Message" SET "updatedAt" = ${updatedAt} WHERE id = ${assistantMessage.id}`;
  return { userMessage, assistantMessage, run };
}
