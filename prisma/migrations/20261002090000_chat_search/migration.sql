-- Search over chat titles and message content (GET /api/chats/search).
--   - Trigram GIN indexes let ILIKE '%term%' find a rare term through the index instead of reading every message.
--   - Message("userId") bounds a common term (one that matches most rows, where the trigram index doesn't help) to the
--     caller's own messages; without it the planner reads every user's messages.
-- Additive (an extension and three indexes): older code ignores them. Neon and the local postgres:16 image ship pg_trgm.
-- Building an index blocks writes to its table while it runs. On a large production table, build these by hand first
-- with CREATE INDEX CONCURRENTLY (same names and definitions); this migration then skips them.
-- Rollback: DROP INDEX "Message_userId_idx"; DROP INDEX "Message_content_trgm_idx"; DROP INDEX "Chat_title_trgm_idx";
--           DROP EXTENSION pg_trgm;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Chat_title_trgm_idx" ON "Chat" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Message_content_trgm_idx" ON "Message" USING GIN ("content" gin_trgm_ops);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Message_userId_idx" ON "Message"("userId");
