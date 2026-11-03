-- П5: помощник в Telegram. Привязка по user id, связка действий одной карточкой, подключённые группы.
ALTER TABLE "Agent" ADD COLUMN "telegramUserId" TEXT;
-- Личный чат с ботом имеет chat.id = user id, поэтому уже привязанные сотрудники получают user id сразу.
UPDATE "Agent" SET "telegramUserId" = "telegramChatId" WHERE "telegramChatId" ~ '^[0-9]+$';
CREATE UNIQUE INDEX "Agent_telegramUserId_key" ON "Agent"("telegramUserId");

ALTER TABLE "AssistantAction" ADD COLUMN "bundleId" TEXT;
CREATE INDEX "AssistantAction_bundleId_idx" ON "AssistantAction"("bundleId");

CREATE TABLE "AssistantTelegramGroup" (
    "chatId" TEXT NOT NULL,
    "registeredByAgentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantTelegramGroup_pkey" PRIMARY KEY ("chatId")
);
