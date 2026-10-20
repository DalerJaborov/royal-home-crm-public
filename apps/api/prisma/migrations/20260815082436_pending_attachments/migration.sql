-- AlterTable
ALTER TABLE "BotConversation" ADD COLUMN     "pendingAttachments" JSONB NOT NULL DEFAULT '[]';
