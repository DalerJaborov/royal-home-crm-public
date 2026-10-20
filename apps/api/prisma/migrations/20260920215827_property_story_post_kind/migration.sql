-- AlterTable
ALTER TABLE "PropertyStoryPost" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'VIDEO';

-- CreateIndex
CREATE INDEX "PropertyStoryPost_propertyId_kind_publishedAt_idx" ON "PropertyStoryPost"("propertyId", "kind", "publishedAt");
