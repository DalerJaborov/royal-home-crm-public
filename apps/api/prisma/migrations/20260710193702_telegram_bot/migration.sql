-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "telegramChatId" TEXT,
ADD COLUMN     "telegramUsername" TEXT;

-- CreateTable
CREATE TABLE "TelegramConversation" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "username" TEXT,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "leadDraft" JSONB,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramConversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramConversation_chatId_key" ON "TelegramConversation"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramConversation_clientId_key" ON "TelegramConversation"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_telegramChatId_key" ON "Client"("telegramChatId");

-- AddForeignKey
ALTER TABLE "TelegramConversation" ADD CONSTRAINT "TelegramConversation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

