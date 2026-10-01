-- What Magica reported a tool call's run used (its microcredits), kept next to the app credits we charged.
-- Additive (a nullable column): older code ignores it.
-- Rollback: ALTER TABLE "ToolInvocation" DROP COLUMN "providerCost";

-- AlterTable
ALTER TABLE "ToolInvocation" ADD COLUMN "providerCost" INTEGER;

-- An invocation's charge and costs are never negative.
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_costs_valid" CHECK (("creditCost" IS NULL OR "creditCost" >= 0) AND ("providerCost" IS NULL OR "providerCost" >= 0) AND ("durationMs" IS NULL OR "durationMs" >= 0));
