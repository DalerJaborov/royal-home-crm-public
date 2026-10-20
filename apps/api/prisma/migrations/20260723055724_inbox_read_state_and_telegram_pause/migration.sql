-- AlterTable
ALTER TABLE "BotConversation" ADD COLUMN     "readAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TelegramConversation" ADD COLUMN     "lastMessageAt" TIMESTAMP(3),
ADD COLUMN     "pausedUntil" TIMESTAMP(3),
ADD COLUMN     "readAt" TIMESTAMP(3);
