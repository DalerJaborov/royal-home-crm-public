-- Задачи от команды: просьбы сотрудников из личной переписки в Telegram
-- (голосовые расшифровываются и разбираются ИИ в структуру).

CREATE TYPE "TeamRequestType" AS ENUM ('BUG', 'FEATURE', 'QUESTION', 'INFO', 'OTHER');
CREATE TYPE "TeamRequestPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');
CREATE TYPE "TeamRequestStatus" AS ENUM ('NEW', 'CLARIFYING', 'IN_PROGRESS', 'DONE', 'REJECTED');

CREATE TABLE "TeamRequest" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'TELEGRAM_BUSINESS',
    "authorName" TEXT,
    "authorUsername" TEXT,
    "chatId" TEXT,
    "telegramMessageId" INTEGER,
    "partIndex" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'TEXT',
    "rawText" TEXT NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "area" TEXT,
    "type" "TeamRequestType" NOT NULL DEFAULT 'OTHER',
    "priority" "TeamRequestPriority" NOT NULL DEFAULT 'NORMAL',
    "openQuestions" JSONB NOT NULL DEFAULT '[]',
    "status" "TeamRequestStatus" NOT NULL DEFAULT 'NEW',
    "seenAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamRequest_pkey" PRIMARY KEY ("id")
);

-- Защита от повторной обработки одного и того же сообщения Telegram при перезапуске
-- поллера. NULL-и Postgres считает различными, поэтому ручные записи (source=MANUAL,
-- без chatId/messageId) под ограничение не попадают и не конфликтуют между собой.
CREATE UNIQUE INDEX "TeamRequest_chatId_telegramMessageId_partIndex_key" ON "TeamRequest"("chatId", "telegramMessageId", "partIndex");
CREATE INDEX "TeamRequest_status_createdAt_idx" ON "TeamRequest"("status", "createdAt");

-- Личный чат директора с ботом и id бизнес-подключения: заполняются автоматически,
-- когда директор подключает бота в Telegram Business (апдейт business_connection).
ALTER TABLE "Settings" ADD COLUMN "telegramOwnerChatId" TEXT;
ALTER TABLE "Settings" ADD COLUMN "telegramBusinessConnId" TEXT;
