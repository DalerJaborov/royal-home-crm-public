-- AlterTable
ALTER TABLE "BotConversation" ADD COLUMN     "guideAwaitFollowAt" TIMESTAMP(3),
ADD COLUMN     "guideSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MessengerAccount" ADD COLUMN     "username" TEXT;
