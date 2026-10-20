-- AlterTable
ALTER TABLE "RoyalScoreEvent" ADD COLUMN     "sourceId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "RoyalScoreEvent_kind_sourceId_key" ON "RoyalScoreEvent"("kind", "sourceId");

