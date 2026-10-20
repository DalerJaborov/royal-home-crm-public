-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "instagramStoriesEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PropertyStoryPost" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "partIndex" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyStoryPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyStoryPost_propertyId_publishedAt_idx" ON "PropertyStoryPost"("propertyId", "publishedAt");

-- AddForeignKey
ALTER TABLE "PropertyStoryPost" ADD CONSTRAINT "PropertyStoryPost_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
