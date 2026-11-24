-- Шабнам в рабочих группах (24.11.2026): отвечает без обращения (рубильник, ВКЛ),
-- директор может выключить память группы, новичку один раз предлагает привязку по номеру.
-- Только новые колонки и новая таблица, существующие данные не меняются.
ALTER TABLE "Settings" ADD COLUMN "shabnamGroupUnaddressedEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AssistantTelegramGroup" ADD COLUMN "contextOptOutAt" TIMESTAMP(3);

CREATE TABLE "AssistantTelegramLinkOffer" (
    "telegramUserId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "offeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contactRequestedAt" TIMESTAMP(3),

    CONSTRAINT "AssistantTelegramLinkOffer_pkey" PRIMARY KEY ("telegramUserId")
);
