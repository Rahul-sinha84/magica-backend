-- Waitpoints: a run paused until the user answers (plan approval, credit approval).
-- Additive (one table, two enums, their indexes): older code ignores it.
-- Rollback: DROP TABLE "Waitpoint"; DROP TYPE "WaitpointStatus"; DROP TYPE "WaitpointType";
-- CreateEnum
CREATE TYPE "WaitpointType" AS ENUM ('PLAN', 'CREDIT');

-- CreateEnum
CREATE TYPE "WaitpointStatus" AS ENUM ('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Waitpoint" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "type" "WaitpointType" NOT NULL,
    "status" "WaitpointStatus" NOT NULL DEFAULT 'PENDING',
    "triggerTokenId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "response" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Waitpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_triggerTokenId_key" ON "Waitpoint"("triggerTokenId");

-- CreateIndex
CREATE INDEX "Waitpoint_agentRunId_createdAt_idx" ON "Waitpoint"("agentRunId", "createdAt");

-- AddForeignKey
ALTER TABLE "Waitpoint" ADD CONSTRAINT "Waitpoint_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One pending waitpoint per run: a run waits for one answer at a time.
CREATE UNIQUE INDEX "Waitpoint_one_pending_per_run" ON "Waitpoint"("agentRunId") WHERE "status" = 'PENDING';

-- Closed exactly when resolved, and an answer is stored exactly when the user answered.
ALTER TABLE "Waitpoint" ADD CONSTRAINT "Waitpoint_resolved_when_closed" CHECK (("status" = 'PENDING') = ("resolvedAt" IS NULL));
ALTER TABLE "Waitpoint" ADD CONSTRAINT "Waitpoint_response_when_answered" CHECK (("status" IN ('APPROVED', 'CHANGES_REQUESTED', 'REJECTED')) = ("response" IS NOT NULL));
ALTER TABLE "Waitpoint" ADD CONSTRAINT "Waitpoint_expires_after_creation" CHECK ("expiresAt" > "createdAt");
