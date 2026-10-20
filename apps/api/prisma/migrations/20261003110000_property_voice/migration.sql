-- «Голос рынка» (03.10.2026) — только добавление: новая таблица и nullable-колонки.
-- Ни одна существующая колонка не меняется и не удаляется.

-- Откуда код узнал, что в диалоге речь об объекте.
CREATE TYPE "ConversationPropertySource" AS ENUM ('SHARED_MEDIA', 'NUMBER_IN_TEXT', 'LISTING_LINK', 'AD_REFERRAL', 'EXPOSURE');

-- Связь «диалог бота ↔ объект».
CREATE TABLE "ConversationProperty" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "source" "ConversationPropertySource" NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hits" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ConversationProperty_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConversationProperty_conversationId_propertyId_key" ON "ConversationProperty"("conversationId", "propertyId");
CREATE INDEX "ConversationProperty_propertyId_idx" ON "ConversationProperty"("propertyId");

ALTER TABLE "ConversationProperty" ADD CONSTRAINT "ConversationProperty_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "BotConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationProperty" ADD CONSTRAINT "ConversationProperty_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Объект разговора (заполняется только когда доказан).
ALTER TABLE "CallAnalysis" ADD COLUMN "propertyId" TEXT;
CREATE INDEX "CallAnalysis_propertyId_idx" ON "CallAnalysis"("propertyId");

-- Объект поста, под которым оставлен комментарий в группе Telegram.
ALTER TABLE "TelegramGroupComment" ADD COLUMN "propertyId" TEXT;
CREATE INDEX "TelegramGroupComment_propertyId_idx" ON "TelegramGroupComment"("propertyId");

-- Индексы под выборки «по объекту» (только индексы существующих колонок).
CREATE INDEX "OwnerQuestion_propertyId_idx" ON "OwnerQuestion"("propertyId");
CREATE INDEX "InstagramComment_propertyId_createdAt_idx" ON "InstagramComment"("propertyId", "createdAt");
