-- Фото-посты для объектов без ролика (28.09.2026, agent-brief.md, решение владельца 26.09.2026).
ALTER TABLE "Settings" ADD COLUMN "photoPostsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "photoPostAfterHours" INTEGER NOT NULL DEFAULT 24;

CREATE TABLE "PropertyPhotoPost" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "mediaId" TEXT,
    "secondaryId" TEXT,
    "permalink" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyPhotoPost_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PropertyPhotoPost_propertyId_channel_idx" ON "PropertyPhotoPost"("propertyId", "channel");
CREATE INDEX "PropertyPhotoPost_status_scheduledAt_idx" ON "PropertyPhotoPost"("status", "scheduledAt");

ALTER TABLE "PropertyPhotoPost" ADD CONSTRAINT "PropertyPhotoPost_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
