-- API keys for the public API (/v1): only a SHA-256 hash of each key is stored.
-- Additive (one table and its indexes): older code ignores it.
-- Rollback: DROP TABLE "ApiKey";
-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "perMinute" INTEGER NOT NULL DEFAULT 60,
    "perDay" INTEGER NOT NULL DEFAULT 1000,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_hash_key" ON "ApiKey"("hash");

-- CreateIndex
CREATE INDEX "ApiKey_userId_createdAt_idx" ON "ApiKey"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The limits the API offers (as in the reference docs), a label someone can read, and the key's stored form.
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_limits_valid" CHECK ("perMinute" BETWEEN 1 AND 10000 AND "perDay" BETWEEN 1 AND 100000);
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_label_valid" CHECK (char_length("label") BETWEEN 1 AND 64);
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_hash_hex" CHECK ("hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_prefix_valid" CHECK ("prefix" ~ '^mgc_[A-Za-z0-9_-]{8}$');
