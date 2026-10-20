-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "videoHandoffQueuePauseReason" TEXT,
ADD COLUMN     "videoHandoffQueuePausedAt" TIMESTAMP(3),
ADD COLUMN     "videoHandoffQueuePausedById" TEXT;
