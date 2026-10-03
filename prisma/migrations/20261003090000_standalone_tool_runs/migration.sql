-- Standalone tool runs (public API): a tool call can exist without an agent run, so it records who pays for it.
-- userId is backfilled from each call's run, then required. A call made by a run still has its run.
-- Rollback: DELETE FROM "ToolInvocation" WHERE "agentRunId" IS NULL;
--           ALTER TABLE "ToolInvocation" ALTER COLUMN "agentRunId" SET NOT NULL;
--           ALTER TABLE "ToolInvocation" DROP CONSTRAINT "ToolInvocation_userId_fkey"; DROP INDEX "ToolInvocation_userId_createdAt_idx";
--           ALTER TABLE "ToolInvocation" DROP COLUMN "userId";

-- AlterTable
ALTER TABLE "ToolInvocation" ADD COLUMN "userId" TEXT;
UPDATE "ToolInvocation" t SET "userId" = r."userId" FROM "AgentRun" r WHERE r."id" = t."agentRunId";
ALTER TABLE "ToolInvocation" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "ToolInvocation" ALTER COLUMN "agentRunId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "ToolInvocation_userId_createdAt_idx" ON "ToolInvocation"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
