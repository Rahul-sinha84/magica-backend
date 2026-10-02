-- Plan mode: how the agent works on a turn (PLAN: paid tools wait for an approved plan). A retry keeps it.
-- Additive (one enum, one column with a default): older code ignores it.
-- Rollback: ALTER TABLE "AgentRun" DROP COLUMN "mode"; DROP TYPE "RunMode";
-- CreateEnum
CREATE TYPE "RunMode" AS ENUM ('DEFAULT', 'PLAN');

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "mode" "RunMode" NOT NULL DEFAULT 'DEFAULT';

