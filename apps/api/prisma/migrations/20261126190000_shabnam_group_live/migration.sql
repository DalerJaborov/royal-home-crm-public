-- «Живая» Шабнам в группах (25.11.2026). Только добавляет колонки.
ALTER TABLE "Settings" ADD COLUMN "shabnamGroupLiveEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "shabnamGroupLiveShadowEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AssistantTelegramGroup" ADD COLUMN "chatMode" TEXT;
ALTER TABLE "AssistantTelegramGroup" ADD COLUMN "liveWindowStartAt" TIMESTAMP(3);
ALTER TABLE "AssistantTelegramGroup" ADD COLUMN "liveWindowCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AssistantTelegramGroup" ADD COLUMN "lastLiveReplyAt" TIMESTAMP(3);
ALTER TABLE "AssistantTelegramGroup" ADD COLUMN "liveDayKey" TEXT;
ALTER TABLE "AssistantTelegramGroup" ADD COLUMN "liveDayCount" INTEGER NOT NULL DEFAULT 0;
