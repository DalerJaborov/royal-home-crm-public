-- AlterTable
ALTER TABLE "BotConversation" ADD COLUMN     "aiProvider" TEXT;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "aiProviderTestEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "BotConversation_aiProvider_idx" ON "BotConversation"("aiProvider");
