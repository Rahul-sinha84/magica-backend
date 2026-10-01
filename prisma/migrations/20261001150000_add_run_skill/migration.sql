-- Skills the agent loaded during a run: the exact text and its sha256, so a repeat load in the same run, or a retry of
-- the run, gets the same guidance even after the skill file changes.
-- Additive (a new table): older code ignores it.
-- Rollback: DROP TABLE "RunSkill";

-- CreateTable
CREATE TABLE "RunSkill" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunSkill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RunSkill_agentRunId_skillName_key" ON "RunSkill"("agentRunId", "skillName");

-- AddForeignKey
ALTER TABLE "RunSkill" ADD CONSTRAINT "RunSkill_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma's schema language can't express these; they keep bad rows out even if application code has a bug.
-- The hash is a sha256 in lowercase hex, and a skill body is at most 32 KB (it must fit the model's context window).
ALTER TABLE "RunSkill" ADD CONSTRAINT "RunSkill_contentHash_sha256" CHECK ("contentHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "RunSkill" ADD CONSTRAINT "RunSkill_content_size" CHECK (octet_length("content") <= 32768);
