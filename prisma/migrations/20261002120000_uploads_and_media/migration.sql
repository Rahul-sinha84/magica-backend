-- Direct uploads (Transloadit) and the media library.
--   Upload: one per uploaded file, from signing to Transloadit's result.
--   MediaAsset: a library file, uploaded (expires with Transloadit's temporary storage) or generated (Magica's CDN).
--   Attachment: a message's files, in order.
-- Additive (three tables, three enums, their indexes): older code ignores them. Uses pg_trgm (chat_search migration).
-- Rollback: DROP TABLE "Attachment"; DROP TABLE "Upload"; DROP TABLE "MediaAsset";
--           DROP TYPE "UploadStatus"; DROP TYPE "MediaSource"; DROP TYPE "MediaType";

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "MediaSource" AS ENUM ('UPLOAD', 'GENERATED');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO');

-- CreateTable
CREATE TABLE "Upload" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assemblyId" TEXT,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "errorMessage" TEXT,
    "mediaAssetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "MediaSource" NOT NULL,
    "type" "MediaType" NOT NULL,
    "url" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "name" TEXT,
    "prompt" TEXT,
    "model" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "mimeType" TEXT,
    "toolInvocationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Upload_assemblyId_key" ON "Upload"("assemblyId");

-- CreateIndex
CREATE UNIQUE INDEX "Upload_mediaAssetId_key" ON "Upload"("mediaAssetId");

-- CreateIndex
CREATE INDEX "Upload_userId_status_createdAt_idx" ON "Upload"("userId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Upload_createdAt_idx" ON "Upload"("createdAt");

-- CreateIndex
CREATE INDEX "MediaAsset_userId_createdAt_id_idx" ON "MediaAsset"("userId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "MediaAsset_userId_source_createdAt_id_idx" ON "MediaAsset"("userId", "source", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "MediaAsset_toolInvocationId_idx" ON "MediaAsset"("toolInvocationId");

-- CreateIndex
CREATE INDEX "MediaAsset_name_trgm_idx" ON "MediaAsset" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "MediaAsset_prompt_trgm_idx" ON "MediaAsset" USING GIN ("prompt" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Attachment_mediaAssetId_idx" ON "Attachment"("mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_messageId_position_key" ON "Attachment"("messageId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_messageId_mediaAssetId_key" ON "Attachment"("messageId", "mediaAssetId");

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_toolInvocationId_fkey" FOREIGN KEY ("toolInvocationId") REFERENCES "ToolInvocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Prisma's schema language can't express these; they keep bad rows out even if application code has a bug.
-- A file is 1 byte to 0.5 GB (Transloadit's Community-plan cap); a finished upload knows its assembly.
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_size_valid" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 500000000);
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_completed_has_assembly" CHECK ("status" <> 'COMPLETED' OR "assemblyId" IS NOT NULL);
-- Uploads expire (Transloadit deletes them); generated media doesn't.
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_expiry_matches_source" CHECK (("source" = 'UPLOAD') = ("expiresAt" IS NOT NULL));
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_dimensions_positive" CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0));
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_url_http" CHECK ("url" ~ '^https?://');
-- At most 10 files per message, positions 0-9.
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_position_valid" CHECK ("position" >= 0 AND "position" < 10);
