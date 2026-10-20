-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "duplicateReviewAskedAgentId" TEXT,
ADD COLUMN     "duplicateReviewAskedAt" TIMESTAMP(3),
ADD COLUMN     "duplicateReviewDueAt" TIMESTAMP(3),
ADD COLUMN     "duplicateReviewMatchedBy" TEXT,
ADD COLUMN     "duplicateReviewOfClientId" TEXT;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "duplicateClaimAnomalyThreshold" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "duplicateReviewTimeoutHours" INTEGER NOT NULL DEFAULT 6;

-- CreateIndex
CREATE INDEX "Client_duplicateReviewDueAt_idx" ON "Client"("duplicateReviewDueAt");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_duplicateReviewOfClientId_fkey" FOREIGN KEY ("duplicateReviewOfClientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_duplicateReviewAskedAgentId_fkey" FOREIGN KEY ("duplicateReviewAskedAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
