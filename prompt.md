We have to create a backend repo for magica assignment, for the frontend app project you can go to magica-frontend in prevcious folder (it's not built yet, but can access the full plan on the github issue for that project github repo name: magica-frontend)

Please analyze it properly and ask me if you have any doubts/questions regarding this and if you find any flaw in the approach please please let me know we can go and fix them accordingly,

Let's have a good Q&A before writing a very good plan if you have any

This is the link for google docs for the system requiremnts: https://docs.google.com/document/d/1fXoil6agMeGo5mCGHo-DpRG8ICTG3q8-fkIT2v8GNhA/edit?usp=sharing (please let me know if you can't access it, i'll manually paste it here, but do not miss this)

The last thing I want to change the plan after it's being executed, so be very very strict and do not assume anything, just ask every step please

# Magica Backend — Day 1 Build

## Context

You are building the BACKEND repository (Repo 2 of 2) for a
production-grade AI agent chat application called Magica.

This is a 3-day work trial. The backend is a standalone Express +
TypeScript application. It owns authentication, APIs, persistence,
the credit ledger, Trigger.dev agent tasks, OpenRouter LLM calls,
Magica tool execution, and upload signing. The frontend (Next.js,
port 3001) communicates with this server over HTTP.

This is evaluated on:

- Architecture & Scalability (25%)
- Reliability & Error Handling (20%)
- Code Quality (15%)
- Feature Completeness (10%)

---

## Your Role

Senior backend engineer. TypeScript strict throughout. No 'any'.
Every architectural decision is intentional and defensible.
Clean, minimal code — least lines for the same functionality wins.

---

## Tech Stack — Non-Negotiable

- Node.js + Express + TypeScript (strict mode)
- PostgreSQL — only database, no MongoDB
- Prisma — ORM + migrations
- Clerk — auth (server-side JWT verification)
- Trigger.dev v3 — durable agent task execution
- OpenRouter Free (openrouter/free) — LLM, no paid fallback
- Zod — validation at every trust boundary
- Vitest — tests
- pnpm — package manager
- Docker Compose — local PostgreSQL

DO NOT use:

- MongoDB or any document database
- Any ORM other than Prisma
- Any LLM other than OpenRouter Free for the core path

---

## Good Patterns From Production (Inherit These)

### Pattern 1: DISPATCHING before external API calls

Before calling any external API (Magica, OpenRouter for tool calls),
write a row with status DISPATCHING first. If the worker crashes
between sending the request and saving the result, you can tell
"never sent" from "sent, outcome unknown." This prevents duplicate
charged calls on retry.

### Pattern 2: One active run per chat — enforced at DB level

A partial unique index on AgentRun ensures only one active run per
chat at the database level, not just application logic. This closes
the race condition where two requests arrive simultaneously.

### Pattern 3: Shared Zod contracts with sync mechanism

src/contracts/ contains the authoritative Zod schemas. A sync
script copies them to the frontend repo with a checksum lockfile.
Frontend build fails if schemas drift. One source of truth.

### Pattern 4: Structured logs on every code path

Every log line in the agent loop carries chatId, runId, messageId,
and traceId. Failed turns are explainable from logs alone.

### Pattern 5: Idempotent dispatch with clientMessageId

POST /api/chats/:chatId/messages accepts an optional clientMessageId.
A double-submit returns the same turn instead of creating a duplicate.

### Pattern 6: Trigger.dev text streams for token delivery

Text tokens stream via Trigger.dev streams (not metadata).
Metadata carries status updates (thinking, calling-tool, complete).
This handles long outputs without hitting metadata size limits.

---

## Repository Structure

magica-backend/
├── src/
│ ├── contracts/ ← authoritative Zod schemas (synced to frontend)
│ │ ├── chats.ts
│ │ ├── messages.ts
│ │ ├── runs.ts
│ │ ├── credits.ts
│ │ └── index.ts
│ ├── db/
│ │ └── client.ts ← Prisma client singleton
│ ├── auth/
│ │ └── middleware.ts ← Clerk JWT verification
│ ├── middleware/
│ │ ├── cors.ts
│ │ ├── errorHandler.ts
│ │ ├── rateLimit.ts
│ │ └── validate.ts ← Zod request validation helper
│ ├── routes/
│ │ ├── chats.ts ← CRUD for chats
│ │ ├── messages.ts ← send + list messages
│ │ ├── runs.ts ← active-run + cancel
│ │ └── credits.ts ← balance endpoint
│ ├── trigger/
│ │ └── agent.ts ← Trigger.dev agent task (the agent loop)
│ ├── lib/
│ │ ├── openrouter.ts ← OpenRouter client + streaming helper
│ │ ├── logger.ts ← structured logger
│ │ └── idempotency.ts ← idempotency key helpers
│ └── server.ts ← Express app setup and entry point
├── prisma/
│ ├── schema.prisma
│ └── migrations/
├── scripts/
│ ├── contracts-sync.mjs ← copies contracts to frontend repo
│ └── smoke.sh ← quick curl tests for all endpoints
├── tests/
│ ├── setup.ts
│ ├── unit/
│ │ ├── contracts.test.ts
│ │ └── openrouter.test.ts
│ └── integration/
│ └── messages.test.ts
├── docker/
│ └── docker-compose.yml
├── docker-compose.yml ← symlink or copy at root for convenience
├── trigger.config.ts ← Trigger.dev config (REQUIRED at root)
├── tsconfig.json
├── vitest.config.ts
├── .env.example
└── README.md

---

## Step 1: Project Setup

```bash
mkdir magica-backend && cd magica-backend
pnpm init

# Core
pnpm add \
  express \
  @prisma/client \
  @clerk/backend \
  @trigger.dev/sdk \
  openai \
  zod \
  cors \
  dotenv \
  helmet \
  express-rate-limit \
  uuid

# Types
pnpm add -D \
  typescript \
  @types/node \
  @types/express \
  @types/cors \
  @types/uuid \
  tsx \
  prisma \
  vitest \
  @vitest/coverage-v8 \
  msw \
  pnpm

# Init TypeScript
npx tsc --init
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*", "trigger.config.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

### package.json scripts

```json
{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest",
    "test:run": "vitest run",
    "db:up": "docker compose up -d postgres",
    "db:down": "docker compose down",
    "db:migrate": "prisma migrate dev",
    "db:deploy": "prisma migrate deploy",
    "db:studio": "prisma studio",
    "db:generate": "prisma generate",
    "contracts:sync": "node scripts/contracts-sync.mjs",
    "trigger:dev": "npx trigger.dev@latest dev"
  }
}
```

### .env.example

PostgreSQL

DATABASE_URL=postgresql://magica:magica@localhost:5432/magica_dev
DIRECT_URL=postgresql://magica:magica@localhost:5432/magica_dev
TEST_DATABASE_URL=postgresql://magica:magica@localhost:5432/magica_test

Clerk

CLERK_SECRET_KEY=
CLERK_PUBLISHABLE_KEY=

Trigger.dev

TRIGGER_SECRET_KEY=
TRIGGER_PROJECT_REF=

OpenRouter

OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

Magica API (Day 2)

MAGICA_API_KEY=
MAGICA_BASE_URL=https://inference.magica.com

Transloadit (Day 2)

TRANSLOADIT_AUTH_KEY=
TRANSLOADIT_AUTH_SECRET=

Server

PORT=3000
FRONTEND_ORIGIN=http://localhost:3001
NODE_ENV=development

---

## Step 2: Docker Compose

### docker/docker-compose.yml

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: magica-postgres
    environment:
      POSTGRES_USER: magica
      POSTGRES_PASSWORD: magica
      POSTGRES_DB: magica_dev
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U magica"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

### docker/init.sql

```sql
-- Create test database
CREATE DATABASE magica_test;
GRANT ALL PRIVILEGES ON DATABASE magica_test TO magica;
```

Also create docker-compose.yml at root pointing to docker/:

```yaml
# Root docker-compose.yml — convenience wrapper
include:
  - docker/docker-compose.yml
```

---

## Step 3: Prisma Schema

### prisma/schema.prisma

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

model User {
  id        String   @id           // Clerk user ID
  email     String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  chats         Chat[]
  creditLedger  CreditLedger[]
  creditBalance Int            @default(10000) // starting credits

  @@index([email])
}

model Chat {
  id            String   @id @default(cuid())
  userId        String
  title         String   @default("New Chat")
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  lastMessageAt DateTime?
  isPinned      Boolean  @default(false)

  user       User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  messages   Message[]
  agentRuns  AgentRun[]

  @@index([userId, lastMessageAt(sort: Desc)])
  @@index([userId, createdAt(sort: Desc)])
}

model Message {
  id            String        @id @default(cuid())
  chatId        String
  userId        String
  role          MessageRole
  content       String?       // plain text (fallback)
  contentBlocks Json          @default("[]") // ContentBlock[] validated with Zod
  status        MessageStatus @default(COMPLETED)
  clientMessageId String?     // idempotency key from client

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  chat      Chat      @relation(fields: [chatId], references: [id], onDelete: Cascade)
  agentRun  AgentRun? @relation("AssistantMessage")

  @@unique([chatId, clientMessageId]) // idempotency: same client key = same message
  @@index([chatId, createdAt(sort: Asc)])
  @@index([userId])
}

model AgentRun {
  id                 String    @id @default(cuid())
  chatId             String
  userId             String
  triggerMessageId   String    // the USER message that triggered this run
  assistantMessageId String?   @unique // the ASSISTANT message produced
  triggerRunId       String?   // Trigger.dev run ID
  status             RunStatus @default(PENDING)
  errorMessage       String?

  startedAt   DateTime?
  completedAt DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  chat             Chat             @relation(fields: [chatId], references: [id], onDelete: Cascade)
  assistantMessage Message?         @relation("AssistantMessage", fields: [assistantMessageId], references: [id])
  toolInvocations  ToolInvocation[]
  creditLedger     CreditLedger[]

  // ONE active run per chat enforced at DB level
  // A partial unique index: only one PENDING or RUNNING run per chat
  @@unique([chatId, status], name: "one_active_run_per_chat", map: "idx_one_active_run_per_chat")
  @@index([chatId, status])
  @@index([triggerRunId])
}

model ToolInvocation {
  id         String              @id @default(cuid())
  agentRunId String
  toolCallId String              // LLM-generated tool call ID
  toolName   String
  status     ToolInvocationStatus @default(PENDING)
  input      Json                // Zod-validated tool input
  output     Json?               // Zod-validated tool output
  errorMessage String?
  magicaRunId String?            // external run ID for Magica API calls

  creditCost  Int?               // settled cost in microcredits
  durationMs  Int?

  dispatchedAt  DateTime?        // when DISPATCHING state was set
  completedAt   DateTime?
  createdAt     DateTime @default(now())

  agentRun AgentRun @relation(fields: [agentRunId], references: [id], onDelete: Cascade)

  @@unique([agentRunId, toolCallId]) // idempotency: same tool call = same row
  @@index([agentRunId])
}

model CreditLedger {
  id         String   @id @default(cuid())
  userId     String
  agentRunId String?
  amount     Int      // positive = credit, negative = debit (microcredits)
  reason     String   // "tool:gpt_image_2", "top-up", "refund", etc.
  idempotencyKey String @unique // prevents double-charging

  createdAt DateTime @default(now())

  user     User      @relation(fields: [userId], references: [id])
  agentRun AgentRun? @relation(fields: [agentRunId], references: [id])

  @@index([userId, createdAt(sort: Desc)])
  @@index([agentRunId])
}

enum MessageRole {
  USER
  ASSISTANT
  SYSTEM
  TOOL
}

enum MessageStatus {
  COMPLETED
  FAILED
  CANCELLED
  STREAMING
}

enum RunStatus {
  PENDING
  RUNNING
  COMPLETED
  FAILED
  CANCELLED
}

enum ToolInvocationStatus {
  PENDING
  DISPATCHING  // written BEFORE the external API call
  RUNNING
  COMPLETED
  FAILED
  CANCELLED
}
```

After writing schema, run:

```bash
pnpm db:up
pnpm db:migrate -- --name init
pnpm db:generate
```

---

## Step 4: Trigger.dev Config

### trigger.config.ts (MUST be at repo root)

```typescript
import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "your-project-ref",
  dirs: ["./src/trigger"], // where your tasks live
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 1, // agent turns do NOT auto-retry blindly
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
    },
  },
});
```

---

## Step 5: Contracts (Shared With Frontend)

These are the authoritative schemas. The sync script copies them
to the frontend repo with checksums.

### src/contracts/chats.ts

```typescript
import { z } from "zod";

export const CreateChatBodySchema = z.object({
  title: z.string().min(1).max(200).optional().default("New Chat"),
});

export const ChatSchema = z.object({
  id: z.string(),
  title: z.string(),
  userId: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastMessageAt: z.string().datetime().nullable(),
  isPinned: z.boolean(),
  _count: z.object({ messages: z.number() }).optional(),
});

export const ChatListResponseSchema = z.object({
  chats: z.array(ChatSchema),
});

export const CreateChatResponseSchema = z.object({
  chat: ChatSchema,
});

export type Chat = z.infer<typeof ChatSchema>;
export type CreateChatBody = z.infer<typeof CreateChatBodySchema>;
```

### src/contracts/messages.ts

```typescript
import { z } from "zod";

export const MessageRoleSchema = z.enum([
  "USER",
  "ASSISTANT",
  "SYSTEM",
  "TOOL",
]);
export const MessageStatusSchema = z.enum([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "STREAMING",
]);

// All content block types — exhaustive
export const TextBlockSchema = z.object({
  type: z.literal("text"),
  content: z.string(),
});

export const ThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  content: z.string(),
  durationMs: z.number().optional(),
});

export const ReasoningBlockSchema = z.object({
  type: z.literal("reasoning"),
  content: z.string(),
});

export const ImageBlockSchema = z.object({
  type: z.literal("image"),
  url: z.string().url(),
  mimeType: z.string().optional(),
  altText: z.string().optional(),
});

export const ToolCallBlockSchema = z.object({
  type: z.literal("tool_call"),
  toolCallId: z.string(),
  toolName: z.string(),
  toolInput: z.record(z.unknown()),
  status: z.enum(["pending", "running", "completed", "failed"]),
  durationMs: z.number().optional(),
  creditCost: z.number().optional(),
});

export const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  toolCallId: z.string(),
  toolName: z.string(),
  result: z.unknown(),
  isError: z.boolean().default(false),
  errorMessage: z.string().optional(),
});

export const CitationBlockSchema = z.object({
  type: z.literal("citation"),
  url: z.string().url(),
  title: z.string().optional(),
  snippet: z.string().optional(),
});

export const UsageBlockSchema = z.object({
  type: z.literal("usage"),
  inputTokens: z.number(),
  outputTokens: z.number(),
  model: z.string(),
  creditCost: z.number().optional(),
});

export const ContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ThinkingBlockSchema,
  ReasoningBlockSchema,
  ImageBlockSchema,
  ToolCallBlockSchema,
  ToolResultBlockSchema,
  CitationBlockSchema,
  UsageBlockSchema,
]);

export const MessageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: MessageRoleSchema,
  content: z.string().nullable(),
  contentBlocks: z.array(ContentBlockSchema),
  status: MessageStatusSchema,
  createdAt: z.string().datetime(),
  agentRunId: z.string().nullable().optional(),
});

export const SendMessageBodySchema = z.object({
  content: z.string().min(1).max(32000),
  attachments: z.array(z.string().url()).max(10).optional().default([]),
  clientMessageId: z.string().uuid().optional(), // idempotency
});

export const SendMessageResponseSchema = z.object({
  message: MessageSchema,
  runId: z.string(),
  chatId: z.string(),
  realtimeToken: z.string(),
  realtimeTokenExpiresAt: z.string().datetime(),
});

export const MessageListResponseSchema = z.object({
  messages: z.array(MessageSchema),
  cursor: z.string().nullable(),
});

export type Message = z.infer<typeof MessageSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type SendMessageBody = z.infer<typeof SendMessageBodySchema>;
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;
```

### src/contracts/runs.ts

```typescript
import { z } from "zod";

export const RunStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export const AgentRunSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  triggerRunId: z.string().nullable(),
  status: RunStatusSchema,
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const ActiveRunResponseSchema = z.object({
  run: AgentRunSchema.nullable(),
  realtimeToken: z.string().nullable(),
  realtimeTokenExpiresAt: z.string().datetime().nullable(),
});

// Emitted via Trigger.dev metadata (status updates)
export const AgentStreamMetadataSchema = z.object({
  status: z.enum([
    "thinking",
    "streaming",
    "calling-tool",
    "complete",
    "failed",
    "cancelled",
    "stopping",
  ]),
  step: z.string().optional(),
  thinkingDurationMs: z.number().optional(),
  currentTool: z
    .object({
      name: z.string(),
      input: z.record(z.unknown()),
      status: z.enum(["running", "completed", "failed"]),
    })
    .optional(),
  error: z.string().optional(),
});

export type AgentRun = z.infer<typeof AgentRunSchema>;
export type AgentStreamMetadata = z.infer<typeof AgentStreamMetadataSchema>;
```

### src/contracts/credits.ts

```typescript
import { z } from "zod";

export const CreditsResponseSchema = z.object({
  balance: z.number(),
  held: z.number().default(0),
});

export type CreditsResponse = z.infer<typeof CreditsResponseSchema>;
```

### src/contracts/index.ts

```typescript
export * from "./chats";
export * from "./messages";
export * from "./runs";
export * from "./credits";
```

---

## Step 6: Contracts Sync Script

### scripts/contracts-sync.mjs

```javascript
/**
 * Syncs src/contracts/ to the frontend repo with checksum lockfile.
 * Run: pnpm contracts:sync
 * Set FRONTEND_REPO_PATH env var to point to your frontend repo.
 */
import { createHash } from "crypto";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  mkdirSync,
} from "fs";
import { join } from "path";

const SOURCE_DIR = "src/contracts";
const FRONTEND_PATH = process.env.FRONTEND_REPO_PATH ?? "../magica-frontend";
const DEST_DIR = join(FRONTEND_PATH, "contracts");
const LOCK_FILE = join(FRONTEND_PATH, "contracts.lock.json");

// Ensure destination exists
mkdirSync(DEST_DIR, { recursive: true });

const files = readdirSync(SOURCE_DIR).filter((f) => f.endsWith(".ts"));
const lock = {};

for (const file of files) {
  const src = join(SOURCE_DIR, file);
  const dest = join(DEST_DIR, file);
  const content = readFileSync(src, "utf8");

  copyFileSync(src, dest);
  lock[file] = createHash("sha256").update(content).digest("hex");
  console.log(`Synced: ${file}`);
}

writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2));
console.log(`\nLock file written → ${LOCK_FILE}`);
console.log("Run pnpm contracts:check in the frontend repo to verify ✓");
```

---

## Step 7: Core Infrastructure

### src/db/client.ts

```typescript
import { PrismaClient } from "@prisma/client";

// Singleton — prevents connection pool exhaustion in dev with hot reload
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
```

### src/lib/logger.ts

```typescript
// Structured logger — every line in the agent loop carries context
type LogContext = {
  chatId?: string;
  runId?: string;
  messageId?: string;
  userId?: string;
  toolName?: string;
  [key: string]: unknown;
};

function formatLog(
  level: string,
  message: string,
  context?: LogContext,
): string {
  return JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context,
  });
}

export const logger = {
  info: (message: string, context?: LogContext) =>
    console.log(formatLog("info", message, context)),

  warn: (message: string, context?: LogContext) =>
    console.warn(formatLog("warn", message, context)),

  error: (message: string, context?: LogContext) =>
    console.error(formatLog("error", message, context)),

  debug: (message: string, context?: LogContext) => {
    if (process.env.NODE_ENV === "development") {
      console.log(formatLog("debug", message, context));
    }
  },
};
```

### src/lib/openrouter.ts

```typescript
import OpenAI from "openai";

// OpenRouter uses the OpenAI SDK interface
export const openrouter = new OpenAI({
  baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  defaultHeaders: {
    "HTTP-Referer": "https://magica.com",
    "X-Title": "Magica Agent Chat",
  },
});

export const FREE_MODEL = "openrouter/auto";

// Format Prisma messages into OpenAI-compatible format
export function formatMessagesForLLM(
  messages: Array<{
    role: string;
    content: string | null;
    contentBlocks: unknown;
  }>,
): OpenAI.ChatCompletionMessageParam[] {
  return messages
    .filter((m) => m.role === "USER" || m.role === "ASSISTANT")
    .map((m) => ({
      role: m.role === "USER" ? ("user" as const) : ("assistant" as const),
      content: m.content ?? "",
    }));
}
```

### src/lib/idempotency.ts

```typescript
import { v4 as uuidv4 } from "uuid";

export function generateIdempotencyKey(prefix: string): string {
  return `${prefix}:${uuidv4()}`;
}

export function toolIdempotencyKey(runId: string, toolCallId: string): string {
  return `tool:${runId}:${toolCallId}`;
}
```

### src/auth/middleware.ts

```typescript
import { Request, Response, NextFunction } from "express";
import { createClerkClient } from "@clerk/backend";
import { prisma } from "@/db/client";
import { logger } from "@/lib/logger";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

export interface AuthedRequest extends Request {
  userId: string;
  sessionId: string;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing authorization header" });
      return;
    }

    const token = authHeader.slice(7);

    // Verify with Clerk
    const { sub: userId, sid: sessionId } = await clerk.verifyToken(token);

    if (!userId) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    // Upsert user — create on first request
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        email: `${userId}@placeholder.com`, // updated when Clerk provides email
        creditBalance: 10000,
      },
    });
    (req as AuthedRequest).userId = userId;
    (req as AuthedRequest).sessionId = sessionId ?? "";

    next();
  } catch (error) {
    logger.error("Auth failed", { error: String(error) });
    res.status(401).json({ error: "Unauthorized" });
  }
}
```

### src/middleware/cors.ts

```typescript
import cors from "cors";

export const corsMiddleware = cors({
  origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3001",
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});
```

### src/middleware/validate.ts

```typescript
import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";

// Validates req.body against a Zod schema, replaces body with parsed result
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "Validation failed",
        issues: result.error.flatten().fieldErrors,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
```

### src/middleware/errorHandler.ts

```typescript
import { Request, Response, NextFunction } from "express";
import { logger } from "@/lib/logger";

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  logger.error("Unhandled error", {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  res.status(500).json({
    error: "Internal server error",
  });
}
```

### src/middleware/rateLimit.ts

```typescript
import rateLimit from "express-rate-limit";

// General API rate limit
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
});

// Stricter limit for message sending (LLM calls are expensive)
export const messageSendRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many messages sent" },
});
```

---

## Step 8: API Routes

### src/routes/chats.ts

```typescript
import { Router } from "express";
import { prisma } from "@/db/client";
import { requireAuth, AuthedRequest } from "@/auth/middleware";
import { validateBody } from "@/middleware/validate";
import { CreateChatBodySchema } from "@/contracts";
import { logger } from "@/lib/logger";

const router = Router();

// GET /api/chats — list user's chats
router.get("/", requireAuth, async (req, res) => {
  const { userId } = req as AuthedRequest;

  const chats = await prisma.chat.findMany({
    where: { userId },
    orderBy: [{ isPinned: "desc" }, { lastMessageAt: "desc" }],
    take: 50,
    include: {
      _count: { select: { messages: true } },
    },
  });

  res.json({
    chats: chats.map((c) => ({
      ...c,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    })),
  });
});

// POST /api/chats — create a new chat
router.post(
  "/",
  requireAuth,
  validateBody(CreateChatBodySchema),
  async (req, res) => {
    const { userId } = req as AuthedRequest;
    const { title } = req.body;

    const chat = await prisma.chat.create({
      data: { userId, title },
    });

    logger.info("Chat created", { chatId: chat.id, userId });

    res.status(201).json({
      chat: {
        ...chat,
        createdAt: chat.createdAt.toISOString(),
        updatedAt: chat.updatedAt.toISOString(),
        lastMessageAt: null,
      },
    });
  },
);

// GET /api/chats/:chatId — get single chat
router.get("/:chatId", requireAuth, async (req, res) => {
  const { userId } = req as AuthedRequest;
  const { chatId } = req.params;

  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId }, // ownership check
    include: { _count: { select: { messages: true } } },
  });

  if (!chat) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }

  res.json({
    chat: {
      ...chat,
      createdAt: chat.createdAt.toISOString(),
      updatedAt: chat.updatedAt.toISOString(),
      lastMessageAt: chat.lastMessageAt?.toISOString() ?? null,
    },
  });
});

// DELETE /api/chats/:chatId
router.delete("/:chatId", requireAuth, async (req, res) => {
  const { userId } = req as AuthedRequest;
  const { chatId } = req.params;

  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId },
  });

  if (!chat) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }

  await prisma.chat.delete({ where: { id: chatId } });

  logger.info("Chat deleted", { chatId, userId });
  res.status(204).send();
});

export { router as chatsRouter };
```

### src/routes/messages.ts

```typescript
import { Router } from "express";
import { prisma } from "@/db/client";
import { requireAuth, AuthedRequest } from "@/auth/middleware";
import { validateBody } from "@/middleware/validate";
import { SendMessageBodySchema } from "@/contracts";
import { messageSendRateLimit } from "@/middleware/rateLimit";
import { agentTask } from "@/trigger/agent";
import { logger } from "@/lib/logger";

const router = Router({ mergeParams: true });

// GET /api/chats/:chatId/messages
router.get("/", requireAuth, async (req, res) => {
  const { userId } = req as AuthedRequest;
  const { chatId } = req.params;
  const cursor = req.query.cursor as string | undefined;

  // Ownership check
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId },
  });
  if (!chat) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }

  const take = 50;
  const messages = await prisma.message.findMany({
    where: { chatId },
    orderBy: { createdAt: "asc" },
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = messages.length > take;
  const items = hasMore ? messages.slice(0, take) : messages;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  res.json({
    messages: items.map(serializeMessage),
    cursor: nextCursor,
  });
});

// POST /api/chats/:chatId/messages — the critical send endpoint
router.post(
  "/",
  requireAuth,
  messageSendRateLimit,
  validateBody(SendMessageBodySchema),
  async (req, res) => {
    const { userId } = req as AuthedRequest;
    const { chatId } = req.params;
    const { content, attachments, clientMessageId } = req.body;

    // 1. Ownership check
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, userId },
    });
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    // 2. Idempotency — return existing turn if same clientMessageId
    if (clientMessageId) {
      const existing = await prisma.message.findFirst({
        where: { chatId, clientMessageId },
        include: { agentRun: true },
      });
      if (existing) {
        logger.info("Returning existing turn (idempotent)", {
          chatId,
          messageId: existing.id,
          userId,
        });
        // Return same response as original
        const run = existing.agentRun;
        res.json(await buildSendResponse(existing, run));
        return;
      }
    }

    // 3. Check no active run exists for this chat
    const activeRun = await prisma.agentRun.findFirst({
      where: { chatId, status: { in: ["PENDING", "RUNNING"] } },
    });
    if (activeRun) {
      res.status(409).json({
        error: "An agent is already running in this chat",
        runId: activeRun.triggerRunId,
      });
      return;
    }

    // 4. Check credits
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.creditBalance < 10) {
      res.status(402).json({ error: "Insufficient credits" });
      return;
    }

    // 5. Persist everything in a transaction
    const { userMessage, agentRun, assistantMessage } =
      await prisma.$transaction(async (tx) => {
        // User message
        const userMessage = await tx.message.create({
          data: {
            chatId,
            userId,
            role: "USER",
            content,
            contentBlocks: [],
            status: "COMPLETED",
            clientMessageId: clientMessageId ?? null,
          },
        });

        // Placeholder assistant message (STREAMING)
        const assistantMessage = await tx.message.create({
          data: {
            chatId,
            userId,
            role: "ASSISTANT",
            content: null,
            contentBlocks: [],
            status: "STREAMING",
          },
        });

        // Agent run record
        const agentRun = await tx.agentRun.create({
          data: {
            chatId,
            userId,
            triggerMessageId: userMessage.id,
            assistantMessageId: assistantMessage.id,
            status: "PENDING",
          },
        });

        // Update chat's lastMessageAt
        await tx.chat.update({
          where: { id: chatId },
          data: { lastMessageAt: new Date() },
        });

        return { userMessage, agentRun, assistantMessage };
      });

    // 6. Dispatch Trigger.dev task
    let triggerRunId: string | null = null;
    try {
      const handle = await agentTask.trigger(
        {
          agentRunId: agentRun.id,
          chatId,
          userId,
          assistantMessageId: assistantMessage.id,
        },
        {
          idempotencyKey: `agent-run:${agentRun.id}`,
        },
      );
      triggerRunId = handle.id;

      await prisma.agentRun.update({
        where: { id: agentRun.id },
        data: { triggerRunId, status: "RUNNING", startedAt: new Date() },
      });
    } catch (error) {
      // Dispatch failed — mark run as failed
      await prisma.agentRun.update({
        where: { id: agentRun.id },
        data: { status: "FAILED", errorMessage: "Failed to dispatch agent" },
      });
      await prisma.message.update({
        where: { id: assistantMessage.id },
        data: { status: "FAILED" },
      });

      logger.error("Trigger.dev dispatch failed", {
        chatId,
        runId: agentRun.id,
        userId,
        error: String(error),
      });

      res
        .status(503)
        .json({ error: "Failed to start agent. Please try again." });
      return;
    }

    logger.info("Message sent, agent dispatched", {
      chatId,
      runId: agentRun.id,
      triggerRunId: triggerRunId ?? "unknown",
      userId,
      messageId: userMessage.id,
    });

    // 7. Get Trigger.dev realtime token
    const { id: publicAccessToken, expiresAt } =
      await agentTask.triggerPublicToken(triggerRunId!);

    res.status(201).json({
      message: serializeMessage(userMessage),
      runId: triggerRunId,
      chatId,
      realtimeToken: publicAccessToken,
      realtimeTokenExpiresAt:
        expiresAt?.toISOString() ??
        new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
  },
);

function serializeMessage(m: {
  id: string;
  chatId: string;
  role: string;
  content: string | null;
  contentBlocks: unknown;
  status: string;
  createdAt: Date;
  agentRunId?: string | null;
}) {
  return {
    id: m.id,
    chatId: m.chatId,
    role: m.role,
    content: m.content,
    contentBlocks: Array.isArray(m.contentBlocks) ? m.contentBlocks : [],
    status: m.status,
    createdAt: m.createdAt.toISOString(),
    agentRunId: (m as { agentRunId?: string | null }).agentRunId ?? null,
  };
}

async function buildSendResponse(
  message: {
    id: string;
    chatId: string;
    role: string;
    content: string | null;
    contentBlocks: unknown;
    status: string;
    createdAt: Date;
  },
  run: { triggerRunId: string | null } | null,
) {
  // Reconstruct send response for idempotent requests
  const triggerRunId = run?.triggerRunId ?? null;
  let realtimeToken = "";
  let realtimeTokenExpiresAt = new Date(
    Date.now() + 30 * 60 * 1000,
  ).toISOString();

  if (triggerRunId) {
    try {
      const { id, expiresAt } =
        await agentTask.triggerPublicToken(triggerRunId);
      realtimeToken = id;
      realtimeTokenExpiresAt =
        expiresAt?.toISOString() ?? realtimeTokenExpiresAt;
    } catch {
      // Token generation failed — return without realtime
    }
  }

  return {
    message: serializeMessage(message),
    runId: triggerRunId,
    chatId: message.chatId,
    realtimeToken,
    realtimeTokenExpiresAt,
  };
}

export { router as messagesRouter };
```

### src/routes/runs.ts

```typescript
import { Router } from "express";
import { prisma } from "@/db/client";
import { requireAuth, AuthedRequest } from "@/auth/middleware";
import { agentTask } from "@/trigger/agent";
import { logger } from "@/lib/logger";

const router = Router({ mergeParams: true });

// GET /api/chats/:chatId/active-run
// Used by frontend on reload to restore streaming state
router.get("/active-run", requireAuth, async (req, res) => {
  const { userId } = req as AuthedRequest;
  const { chatId } = req.params;

  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }

  const run = await prisma.agentRun.findFirst({
    where: { chatId, status: { in: ["PENDING", "RUNNING"] } },
    orderBy: { createdAt: "desc" },
  });

  if (!run || !run.triggerRunId) {
    res.json({ run: null, realtimeToken: null, realtimeTokenExpiresAt: null });
    return;
  }

  let realtimeToken: string | null = null;
  let realtimeTokenExpiresAt: string | null = null;

  try {
    const { id, expiresAt } = await agentTask.triggerPublicToken(
      run.triggerRunId,
    );
    realtimeToken = id;
    realtimeTokenExpiresAt = expiresAt?.toISOString() ?? null;
  } catch {
    // Run may have already completed — return run without token
  }

  res.json({
    run: {
      id: run.id,
      chatId: run.chatId,
      triggerRunId: run.triggerRunId,
      status: run.status,
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
    },
    realtimeToken,
    realtimeTokenExpiresAt,
  });
});

// POST /api/runs/:runId/cancel
router.post("/cancel", requireAuth, async (req, res) => {
  const { userId } = req as AuthedRequest;
  const { runId } = req.params;

  const run = await prisma.agentRun.findFirst({
    where: { id: runId, userId, status: { in: ["PENDING", "RUNNING"] } },
  });

  if (!run) {
    res.status(404).json({ error: "Run not found or already finished" });
    return;
  }

  // Cancel in Trigger.dev
  if (run.triggerRunId) {
    try {
      await agentTask.cancel(run.triggerRunId);
    } catch (error) {
      logger.warn("Trigger.dev cancel failed", { runId, error: String(error) });
    }
  }

  // Mark as cancelled in DB
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "CANCELLED", completedAt: new Date() },
  });

  if (run.assistantMessageId) {
    await prisma.message.update({
      where: { id: run.assistantMessageId },
      data: { status: "CANCELLED" },
    });
  }

  logger.info("Run cancelled", { runId, userId });
  res.status(200).json({ cancelled: true });
});

export { router as runsRouter };
```

### src/routes/credits.ts

```typescript
import { Router } from "express";
import { prisma } from "@/db/client";
import { requireAuth, AuthedRequest } from "@/auth/middleware";

const router = Router();

// GET /api/credits
router.get("/", requireAuth, async (req, res) => {
  const { userId } = req as AuthedRequest;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { creditBalance: true },
  });

  res.json({
    balance: user?.creditBalance ?? 0,
    held: 0, // Day 2: implement credit holds
  });
});

export { router as creditsRouter };
```

---

## Step 9: The Agent Task

This is the heart of the backend. Runs on Trigger.dev cloud.
Day 1: text streaming only, no tool calls.

### src/trigger/agent.ts

```typescript
import { task, metadata } from "@trigger.dev/sdk/v3";
import { prisma } from "@/db/client";
import { openrouter, FREE_MODEL, formatMessagesForLLM } from "@/lib/openrouter";
import { logger } from "@/lib/logger";
import { AgentStreamMetadata } from "@/contracts";
import { ContentBlockSchema } from "@/contracts";
import { z } from "zod";

interface AgentTaskPayload {
  agentRunId: string;
  chatId: string;
  userId: string;
  assistantMessageId: string;
}

export const agentTask = task({
  id: "agent-turn",
  // Do NOT auto-retry — blind retries could repeat LLM calls
  retry: { maxAttempts: 1 },

  run: async (payload: AgentTaskPayload) => {
    const { agentRunId, chatId, userId, assistantMessageId } = payload;

    const log = (message: string, extra?: Record<string, unknown>) =>
      logger.info(message, { chatId, runId: agentRunId, userId, ...extra });

    log("Agent task started");

    // Update run status
    await prisma.agentRun.update({
      where: { id: agentRunId },
      data: { status: "RUNNING", startedAt: new Date() },
    });

    // Emit thinking status
    await emitMetadata({ status: "thinking", step: "Loading conversation…" });

    let fullText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let model = FREE_MODEL;

    try {
      // 1. Load conversation history from DB
      const messages = await prisma.message.findMany({
        where: { chatId, status: "COMPLETED" },
        orderBy: { createdAt: "asc" },
        take: 100, // bounded — don't load unbounded history
      });

      log("Loaded conversation history", { messageCount: messages.length });

      const formattedMessages = formatMessagesForLLM(messages);

      if (formattedMessages.length === 0) {
        throw new Error("No messages to process");
      }

      // 2. Emit streaming status
      await emitMetadata({ status: "streaming", step: "Generating response…" });

      // 3. Call OpenRouter Free with streaming
      // Using Trigger.dev text streams (Option 2 — not metadata)
      const textStream = await metadata.stream(
        "text",
        streamOpenRouter(formattedMessages),
      );

      // Accumulate the full text as it streams
      for await (const token of textStream) {
        fullText += token;
        // Note: tokens are delivered to frontend via the stream
        // No need to emit metadata for each token
      }

      // Parse usage from stream (done separately after stream ends)
      // OpenRouter returns usage in the final chunk
      log("Streaming complete", { outputLength: fullText.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Agent task failed", { error: message });

      await emitMetadata({ status: "failed", error: message });

      // Persist failure
      await persistFailure(agentRunId, assistantMessageId, message);
      return;
    }

    // 4. Persist the completed assistant message
    try {
      const contentBlocks = [
        ContentBlockSchema.parse({ type: "text", content: fullText }),
      ];

      await prisma.$transaction([
        prisma.message.update({
          where: { id: assistantMessageId },
          data: {
            content: fullText,
            contentBlocks: contentBlocks as unknown as object[],
            status: "COMPLETED",
          },
        }),
        prisma.agentRun.update({
          where: { id: agentRunId },
          data: { status: "COMPLETED", completedAt: new Date() },
        }),
        prisma.chat.update({
          where: { id: chatId },
          data: { lastMessageAt: new Date() },
        }),
      ]);

      log("Assistant message persisted");
    } catch (error) {
      log("Failed to persist assistant message", { error: String(error) });
      await persistFailure(
        agentRunId,
        assistantMessageId,
        "Failed to save response",
      );
      return;
    }

    // 5. Emit complete
    await emitMetadata({ status: "complete" });
    log("Agent task completed successfully");
  },
});

// Helper: emit metadata for status updates
async function emitMetadata(status: AgentStreamMetadata): Promise<void> {
  const entries = Object.entries(status) as [string, unknown][];
  for (const [key, value] of entries) {
    await metadata.set(key, value);
  }
}

// Helper: generator that calls OpenRouter and yields tokens
async function* streamOpenRouter(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): AsyncGenerator<string> {
  const stream = await openrouter.chat.completions.create({
    model: FREE_MODEL,
    messages,
    stream: true,
    max_tokens: 2048,
    temperature: 0.7,
  });

  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content;
    if (token) {
      yield token;
    }

    // Handle rate limit
    if (chunk.choices[0]?.finish_reason === "length") {
      break;
    }
  }
}

// Helper: persist a failed turn
async function persistFailure(
  agentRunId: string,
  assistantMessageId: string,
  errorMessage: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.agentRun.update({
      where: { id: agentRunId },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        errorMessage,
      },
    }),
    prisma.message.update({
      where: { id: assistantMessageId },
      data: { status: "FAILED" },
    }),
  ]);
}
```

---

## Step 10: Express Server

### src/server.ts

```typescript
import "dotenv/config";
import express from "express";
import helmet from "helmet";
import { corsMiddleware } from "@/middleware/cors";
import { apiRateLimit } from "@/middleware/rateLimit";
import { errorHandler } from "@/middleware/errorHandler";
import { chatsRouter } from "@/routes/chats";
import { messagesRouter } from "@/routes/messages";
import { runsRouter } from "@/routes/runs";
import { creditsRouter } from "@/routes/credits";
import { logger } from "@/lib/logger";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// Security + parsing
app.use(helmet());
app.use(corsMiddleware);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
app.use("/api", apiRateLimit);

// Health check — no auth
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? "0.0.1",
  });
});

// Routes
app.use("/api/chats", chatsRouter);
app.use("/api/chats/:chatId/messages", messagesRouter);
app.use("/api/chats/:chatId", runsRouter); // active-run
app.use("/api/runs/:runId", runsRouter); // cancel
app.use("/api/credits", creditsRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler (must be last)
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info("Server started", {
    port: PORT,
    env: process.env.NODE_ENV,
    frontend: process.env.FRONTEND_ORIGIN,
  });
});

export { app };
```

---

## Step 11: Tests

### vitest.config.ts

```typescript
import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
```

### tests/setup.ts

```typescript
import { beforeAll, afterAll } from "vitest";

// Global test setup
beforeAll(async () => {
  // Ensure test env
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ??
    "postgresql://magica:magica@localhost:5432/magica_test";
});

afterAll(async () => {
  // Cleanup
});
```

### tests/unit/contracts.test.ts

```typescript
import { describe, it, expect } from "vitest";
import {
  ChatSchema,
  SendMessageBodySchema,
  MessageSchema,
  ContentBlockSchema,
  AgentStreamMetadataSchema,
} from "@/contracts";

describe("ChatSchema", () => {
  it("parses valid chat", () => {
    const data = {
      id: "c1",
      title: "Test",
      userId: "u1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastMessageAt: null,
      isPinned: false,
    };
    expect(() => ChatSchema.parse(data)).not.toThrow();
  });

  it("rejects chat without id", () => {
    expect(() => ChatSchema.parse({ title: "No id" })).toThrow();
  });
});

describe("SendMessageBodySchema", () => {
  it("parses valid body", () => {
    const result = SendMessageBodySchema.parse({ content: "Hello" });
    expect(result.content).toBe("Hello");
    expect(result.attachments).toEqual([]);
  });

  it("rejects empty content", () => {
    expect(() => SendMessageBodySchema.parse({ content: "" })).toThrow();
  });

  it("rejects content over 32000 chars", () => {
    expect(() =>
      SendMessageBodySchema.parse({ content: "x".repeat(32001) }),
    ).toThrow();
  });
});

describe("ContentBlockSchema", () => {
  it("parses text block", () => {
    expect(() =>
      ContentBlockSchema.parse({ type: "text", content: "Hi" }),
    ).not.toThrow();
  });

  it("parses tool_call block", () => {
    expect(() =>
      ContentBlockSchema.parse({
        type: "tool_call",
        toolCallId: "tc1",
        toolName: "gpt_image_2",
        toolInput: { prompt: "sunset" },
        status: "running",
      }),
    ).not.toThrow();
  });

  it("rejects unknown block type", () => {
    expect(() => ContentBlockSchema.parse({ type: "unknown" })).toThrow();
  });
});

describe("AgentStreamMetadataSchema", () => {
  it("parses all valid statuses", () => {
    const statuses = [
      "thinking",
      "streaming",
      "calling-tool",
      "complete",
      "failed",
      "cancelled",
      "stopping",
    ];
    for (const status of statuses) {
      expect(() => AgentStreamMetadataSchema.parse({ status })).not.toThrow();
    }
  });
});
```

### tests/unit/openrouter.test.ts

```typescript
import { describe, it, expect } from "vitest";
import { formatMessagesForLLM } from "@/lib/openrouter";

describe("formatMessagesForLLM", () => {
  it("formats USER and ASSISTANT messages", () => {
    const messages = [
      {
        role: "USER",
        content: "Hello",
        contentBlocks: [],
      },
      {
        role: "ASSISTANT",
        content: "Hi there",
        contentBlocks: [],
      },
    ];

    const result = formatMessagesForLLM(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
    expect(result[1]).toEqual({ role: "assistant", content: "Hi there" });
  });

  it("filters out SYSTEM and TOOL messages", () => {
    const messages = [
      { role: "SYSTEM", content: "System", contentBlocks: [] },
      { role: "USER", content: "Hello", contentBlocks: [] },
      { role: "TOOL", content: "Tool result", contentBlocks: [] },
    ];

    const result = formatMessagesForLLM(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("handles null content", () => {
    const messages = [{ role: "USER", content: null, contentBlocks: [] }];
    const result = formatMessagesForLLM(messages);
    expect(result[0].content).toBe("");
  });
});
```

---

## Step 12: Smoke Test Script

### scripts/smoke.sh

```bash
#!/bin/bash
# Quick smoke test for all endpoints
# Usage: ./scripts/smoke.sh
# Requires: jq, curl, a running server on port 3000

BASE="http://localhost:3000/api"
TOKEN="${TEST_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  echo "Set TEST_TOKEN env var to a valid Clerk JWT"
  exit 1
fi

AUTH="Authorization: Bearer $TOKEN"
PASS=0
FAIL=0

check() {
  local name=$1
  local expected_status=$2
  local actual_status=$3

  if [ "$actual_status" = "$expected_status" ]; then
    echo "✔ $name"
    PASS=$((PASS + 1))
  else
    echo "✘ $name (expected $expected_status, got $actual_status)"
    FAIL=$((FAIL + 1))
  fi
}

# Health check (no auth)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/health")
check "GET /health" "200" "$STATUS"

# Credits
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$BASE/credits")
check "GET /credits" "200" "$STATUS"

# List chats
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$BASE/chats")
check "GET /chats" "200" "$STATUS"

# Create chat
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{"title":"Smoke Test Chat"}' "$BASE/chats")
STATUS=$(echo "$RESPONSE" | tail -1)
CHAT_ID=$(echo "$RESPONSE" | head -1 | jq -r '.chat.id // empty')
check "POST /chats" "201" "$STATUS"

if [ -n "$CHAT_ID" ]; then
  # Get single chat
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$BASE/chats/$CHAT_ID")
  check "GET /chats/:chatId" "200" "$STATUS"

  # List messages
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$BASE/chats/$CHAT_ID/messages")
  check "GET /chats/:chatId/messages" "200" "$STATUS"

  # Get active run (should be null)
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$BASE/chats/$CHAT_ID/active-run")
  check "GET /chats/:chatId/active-run" "200" "$STATUS"

  # Delete chat
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE -H "$AUTH" "$BASE/chats/$CHAT_ID")
  check "DELETE /chats/:chatId" "204" "$STATUS"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
```

```bash
chmod +x scripts/smoke.sh
```

---

## Step 13: README.md

```markdown
# Magica Backend

API, agent execution, and database for the Magica chat platform.

Backend: Express + TypeScript · PostgreSQL + Prisma · Clerk ·
Trigger.dev · OpenRouter Free · Zod

Frontend repo: magica-frontend (runs on :3001, this runs on :3000)

## Setup

pnpm install
cp .env.example .env.local # fill in all values
pnpm db:up # start PostgreSQL via Docker
pnpm db:migrate # run migrations
pnpm db:generate # generate Prisma client

# Terminal 1: API server

pnpm dev # http://localhost:3000

# Terminal 2: Trigger.dev worker

pnpm trigger:dev

## Smoke test

TEST_TOKEN=<clerk-jwt> ./scripts/smoke.sh

## Sync contracts to frontend

FRONTEND_REPO_PATH=../magica-frontend pnpm contracts:sync

## Architecture

**Contracts** — src/contracts/ is the single source of truth for
all API shapes. pnpm contracts:sync copies them to the frontend
with a checksum lockfile. Frontend build fails if schemas drift.

**Agent loop** — Trigger.dev task (src/trigger/agent.ts) runs
the OpenRouter agent on Trigger.dev cloud. Text streams via
Trigger.dev streams (token by token). Status updates go through
run metadata. PostgreSQL is always the durable source of truth.

**Idempotency** — Every external call is guarded: clientMessageId
prevents duplicate messages, one-active-run-per-chat enforced by
DB partial unique index, tool calls are idempotent via agentRunId

- toolCallId composite unique key.

**Reliability** — Failed turns persist with error details. Partial
text is preserved. Every log line carries chatId, runId, messageId.
Failed turns are explainable from logs alone.

## DB Schema Summary

User → Chat → Message (cursor-paginated)
Chat → AgentRun (one active per chat at DB level)
AgentRun → ToolInvocation (idempotent per toolCallId)
User → CreditLedger (audit trail, idempotency key per charge)
```

---

## Build Order — Follow Exactly

pnpm install
tsconfig.json
package.json scripts
.env.example → .env.local (fill in values)
docker/docker-compose.yml + docker/init.sql
trigger.config.ts ← MUST be at root before any trigger code
prisma/schema.prisma
pnpm db:up && pnpm db:migrate && pnpm db:generate
src/contracts/ (all 5 files)
node scripts/contracts-generate-lock.mjs (if frontend exists)
src/db/client.ts
src/lib/logger.ts
src/lib/openrouter.ts
src/lib/idempotency.ts
src/auth/middleware.ts
src/middleware/cors.ts
src/middleware/validate.ts
src/middleware/errorHandler.ts
src/middleware/rateLimit.ts
src/routes/credits.ts
src/routes/chats.ts
src/routes/runs.ts
src/trigger/agent.ts
src/routes/messages.ts ← depends on agentTask
src/server.ts
vitest.config.ts
tests/setup.ts
tests/unit/contracts.test.ts
tests/unit/openrouter.test.ts
scripts/contracts-sync.mjs
scripts/smoke.sh + chmod +x
README.md

After step 8: verify prisma generate worked
After step 25: pnpm tsc --noEmit
After step 29: pnpm test:run

---

## Three Things That Must Work by EOD

1. Server starts: pnpm dev → GET /api/health returns 200
2. All smoke tests pass (except send message — needs Trigger.dev)
3. pnpm tsc --noEmit with zero errors

Trigger.dev agent streaming connects once TRIGGER_SECRET_KEY
and OPENROUTER_API_KEY are set and pnpm trigger:dev is running.

---

## What Gets Added on Day 2

- Magica tool integrations (Crop Image, GPT Image 2, Merge Videos)
- Tool calling in the agent loop
- Credit reservation and settlement
- Transloadit signed upload endpoint
- Skills system (agent-skills/ directory)

All of Day 2 slots into existing patterns —
no architectural changes to what's built today.

---

## Start Now

Run the commands in Build Order steps 1-8 first.
Then build files in order.
After step 25 run: pnpm tsc --noEmit
After step 29 run: pnpm test:run
Run pnpm dev and curl /api/health to verify the server works.
