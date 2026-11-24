-- Шабнам в рабочих группах (24.11.2026): отвечает без обращения (рубильник, ВКЛ),
-- директор может выключить память группы, новичку один раз предлагает привязку.
-- Привязка Telegram по номеру (ревью 25.11.2026): рубильник ВЫКЛ, при ВКЛ номер подтверждается кодом.
-- Только новые колонки и новая таблица, существующие данные не меняются.
ALTER TABLE "Settings" ADD COLUMN "shabnamGroupUnaddressedEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "telegramPhoneLinkEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AssistantTelegramGroup" ADD COLUMN "contextOptOutAt" TIMESTAMP(3);

CREATE TABLE "AssistantTelegramLinkOffer" (
    "telegramUserId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "offeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contactRequestedAt" TIMESTAMP(3),
    "pendingAgentId" TEXT,
    "codeSentAt" TIMESTAMP(3),

    CONSTRAINT "AssistantTelegramLinkOffer_pkey" PRIMARY KEY ("telegramUserId")
);

CREATE INDEX "AssistantTelegramLinkOffer_offeredAt_idx" ON "AssistantTelegramLinkOffer"("offeredAt");

-- Назначение кода (повторное ревью 25.11.2026): код привязки Telegram не пускает в CRM и наоборот.
-- Все уже выданные коды — коды входа (DEFAULT 'login').
ALTER TABLE "LoginSmsCode" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'login';
CREATE INDEX "LoginSmsCode_agentId_purpose_createdAt_idx" ON "LoginSmsCode"("agentId", "purpose", "createdAt");
