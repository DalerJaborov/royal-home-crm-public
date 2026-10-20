-- CreateEnum
CREATE TYPE "PropertyVideoHandoffStatus" AS ENUM ('NONE', 'QUEUED', 'SENT_TO_EDITOR', 'RECEIVED');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "telegramChatId" TEXT,
ADD COLUMN     "telegramLinkCode" TEXT;

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "videoHandoffFinalPath" TEXT,
ADD COLUMN     "videoHandoffSentAt" TIMESTAMP(3),
ADD COLUMN     "videoHandoffStatus" "PropertyVideoHandoffStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "videoHandoffVideoId" TEXT;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "agentLossSeriesThreshold" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "buyerThinkingFinalTrackDays" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "buyerThinkingSlowTrackCycles" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "noAnswerTailDay1" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "noAnswerTailDay2" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "noAnswerTailEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sellerNegotiationMaxRounds" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "videoHandoffEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "videoModeratorAgentId" TEXT,
ADD COLUMN     "videoMontajerAgentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Agent_telegramChatId_key" ON "Agent"("telegramChatId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_telegramLinkCode_key" ON "Agent"("telegramLinkCode");

