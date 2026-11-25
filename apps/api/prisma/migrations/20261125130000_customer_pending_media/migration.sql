-- Файлы клиента, ждущие свою реплику (25.11.2026). Только новая таблица.
CREATE TABLE "CustomerPendingMedia" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "mid" TEXT NOT NULL,
    "files" JSONB NOT NULL DEFAULT '[]',
    "lost" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerPendingMedia_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerPendingMedia_channel_subscriberId_mid_key" ON "CustomerPendingMedia"("channel", "subscriberId", "mid");
CREATE INDEX "CustomerPendingMedia_createdAt_idx" ON "CustomerPendingMedia"("createdAt");
