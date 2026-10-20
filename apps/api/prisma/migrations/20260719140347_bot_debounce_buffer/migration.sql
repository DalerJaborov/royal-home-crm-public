-- AlterTable
ALTER TABLE "BotConversation" ADD COLUMN     "lastMessageAt" TIMESTAMP(3),
ADD COLUMN     "pendingMessages" JSONB NOT NULL DEFAULT '[]';
