-- Кнопка «Позвонить» в WhatsApp и ссылка из Instagram/Facebook в WhatsApp с кодом продолжения (владелец 25.11.2026).
-- Только новые колонки и новая таблица, без переписи данных. Оба рубильника ВЫКЛ: поведение бота до включения не меняется.
ALTER TABLE "Settings" ADD COLUMN "botWaCallButton" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "botIgWhatsappLink" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "metaWaDisplayPhone" TEXT;
ALTER TABLE "Settings" ADD COLUMN "waCallingReadyAt" TIMESTAMP(3);

CREATE TABLE "WhatsappContinuationCode" (
    "code" TEXT NOT NULL,
    "sourceConversationId" TEXT NOT NULL,
    "sourceChannel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByConversationId" TEXT,

    CONSTRAINT "WhatsappContinuationCode_pkey" PRIMARY KEY ("code")
);

CREATE INDEX "WhatsappContinuationCode_sourceConversationId_idx" ON "WhatsappContinuationCode"("sourceConversationId");
CREATE INDEX "WhatsappContinuationCode_usedByConversationId_idx" ON "WhatsappContinuationCode"("usedByConversationId");
CREATE INDEX "WhatsappContinuationCode_expiresAt_idx" ON "WhatsappContinuationCode"("expiresAt");

ALTER TABLE "WhatsappContinuationCode" ADD CONSTRAINT "WhatsappContinuationCode_sourceConversationId_fkey"
  FOREIGN KEY ("sourceConversationId") REFERENCES "BotConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WhatsappContinuationCode" ADD CONSTRAINT "WhatsappContinuationCode_usedByConversationId_fkey"
  FOREIGN KEY ("usedByConversationId") REFERENCES "BotConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
