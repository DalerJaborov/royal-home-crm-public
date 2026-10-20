-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "telegramDirectMessagesEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TelegramDirectConversation" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "fromUserId" TEXT,
    "username" TEXT,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "leadDraft" JSONB,
    "clientId" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "pausedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramDirectConversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelegramDirectConversation_lastMessageAt_idx" ON "TelegramDirectConversation"("lastMessageAt");

-- CreateIndex
CREATE INDEX "TelegramDirectConversation_clientId_idx" ON "TelegramDirectConversation"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramDirectConversation_chatId_topicId_key" ON "TelegramDirectConversation"("chatId", "topicId");

-- AddForeignKey
ALTER TABLE "TelegramDirectConversation" ADD CONSTRAINT "TelegramDirectConversation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
