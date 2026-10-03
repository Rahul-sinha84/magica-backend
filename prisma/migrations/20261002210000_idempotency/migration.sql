-- Idempotency-Key for the public API: one stored answer per (user, endpoint, key).
-- Additive (one table, one enum, their indexes): older code ignores it.
-- Rollback: DROP TABLE "IdempotencyRecord"; DROP TYPE "IdempotencyStatus";
-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('PENDING', 'DONE');

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'PENDING',
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_userId_scope_key_key" ON "IdempotencyRecord"("userId", "scope", "key");

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- An answer is stored exactly when the request is done.
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_done_has_response" CHECK (("status" = 'DONE') = ("responseStatus" IS NOT NULL AND "responseBody" IS NOT NULL));
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_hash_hex" CHECK ("requestHash" ~ '^[0-9a-f]{64}$');
