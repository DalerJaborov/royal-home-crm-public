-- Накрутка повторной пересылкой нераспознанного видео (лид «Муродали»): раз
-- Instagram Messaging API не даёт заблокировать/пожаловаться на отправителя
-- программно, единственное, что может код, — перестать отвечать НАВСЕГДА и
-- дать сотруднику видимый повод сходить заблокировать вручную в приложении.
-- AlterTable
ALTER TABLE "BotConversation" ADD COLUMN "spamFlaggedAt" TIMESTAMP(3);
ALTER TABLE "BotConversation" ADD COLUMN "spamFlagReason" TEXT;

-- CreateIndex
CREATE INDEX "BotConversation_spamFlaggedAt_idx" ON "BotConversation"("spamFlaggedAt");
