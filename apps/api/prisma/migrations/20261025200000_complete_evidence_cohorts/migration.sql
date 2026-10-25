-- AlterEnum
ALTER TYPE "SellerProbeCallStatus" ADD VALUE 'UNKNOWN';

-- AlterTable
ALTER TABLE "SellerProbeCall" ADD COLUMN     "anchorAt" TIMESTAMP(3),
ADD COLUMN     "assignmentAt" TIMESTAMP(3),
ADD COLUMN     "buyerClientId" TEXT,
ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceKey" TEXT,
ADD COLUMN     "sourceKind" TEXT NOT NULL DEFAULT 'POST_SHOWING',
ADD COLUMN     "sourcePhoneHash" TEXT,
ALTER COLUMN "postShowingCallId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "postShowingCohortConfig" JSONB NOT NULL DEFAULT '{}';

-- CreateIndex
CREATE UNIQUE INDEX "SellerProbeCall_sourceKey_key" ON "SellerProbeCall"("sourceKey");

-- CreateIndex
CREATE INDEX "SellerProbeCall_sourceKind_anchorAt_idx" ON "SellerProbeCall"("sourceKind", "anchorAt");

