-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "refusedHighScoreFlaggedAt" TIMESTAMP(3),
ADD COLUMN     "refusedHighScoreNotifiedAt" TIMESTAMP(3);
