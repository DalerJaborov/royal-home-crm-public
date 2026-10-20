-- Свободные ролики в соцсети (владелец 12.10.2026: промо-ролик без объекта, кросспостинг во все сети).
-- Аддитивно: новая таблица, существующие не тронуты.
CREATE TABLE "SocialVideoPost" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "caption" TEXT NOT NULL DEFAULT '',
    "brief" TEXT,
    "videoPath" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "durationSec" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "hasAudio" BOOLEAN,
    "videoCodec" TEXT,
    "coverMode" TEXT NOT NULL DEFAULT 'NONE',
    "coverPath" TEXT,
    "coverSquarePath" TEXT,
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "channelResults" JSONB,
    "publishedChannels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "publishedPostIds" JSONB,
    "instagramUrl" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SocialVideoPost_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SocialVideoPost_status_scheduledAt_idx" ON "SocialVideoPost"("status", "scheduledAt");
CREATE INDEX "SocialVideoPost_deletedAt_createdAt_idx" ON "SocialVideoPost"("deletedAt", "createdAt");

ALTER TABLE "SocialVideoPost" ADD CONSTRAINT "SocialVideoPost_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
