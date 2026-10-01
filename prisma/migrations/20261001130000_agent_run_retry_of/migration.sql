-- Retry of a failed or cancelled turn (POST /api/runs/:runId/retry). The unique index makes a double-submitted retry
-- give back the same retry instead of starting a second one.
-- Additive (a nullable column): older code ignores it.
-- Rollback: ALTER TABLE "AgentRun" DROP CONSTRAINT "AgentRun_retryOfRunId_fkey"; DROP INDEX "AgentRun_retryOfRunId_key";
--           ALTER TABLE "AgentRun" DROP COLUMN "retryOfRunId";

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN "retryOfRunId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_retryOfRunId_key" ON "AgentRun"("retryOfRunId");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_retryOfRunId_fkey" FOREIGN KEY ("retryOfRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
