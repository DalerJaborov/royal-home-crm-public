-- Шабнам публикует ролики и фото без объекта (21.11.2026). Только добавляет: новая таблица и рубильник (ВКЛ).
ALTER TABLE "Settings" ADD COLUMN "shabnamSocialPublishEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "StaffClipIntake" ADD COLUMN "transcript" TEXT;

CREATE TABLE "StaffSocialPost" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "staffClipIntakeId" TEXT,
    "mediaGroupKey" TEXT,
    "request" TEXT,
    "language" TEXT NOT NULL DEFAULT 'RU',
    "channels" JSONB,
    "socialVideoPostId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PREVIEW',
    "previewMessageId" INTEGER,
    "publishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffSocialPost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StaffSocialPost_staffClipIntakeId_key" ON "StaffSocialPost"("staffClipIntakeId");
CREATE UNIQUE INDEX "StaffSocialPost_mediaGroupKey_key" ON "StaffSocialPost"("mediaGroupKey");
CREATE UNIQUE INDEX "StaffSocialPost_socialVideoPostId_key" ON "StaffSocialPost"("socialVideoPostId");
CREATE INDEX "StaffSocialPost_chatId_status_updatedAt_idx" ON "StaffSocialPost"("chatId", "status", "updatedAt");
