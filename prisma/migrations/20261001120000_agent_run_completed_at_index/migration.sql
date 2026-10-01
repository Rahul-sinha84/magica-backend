-- The model status (GET /api/models) reads the most recently ended runs; without this it would scan the table.
-- Additive: older code ignores it. Rollback: DROP INDEX "AgentRun_completedAt_idx";
CREATE INDEX "AgentRun_completedAt_idx" ON "AgentRun"("completedAt" DESC);
