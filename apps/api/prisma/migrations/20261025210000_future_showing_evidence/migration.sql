-- AlterTable
ALTER TABLE "Interaction" ADD COLUMN     "showingEvidenceVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "showingOffCrm" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "showingOffCrmDetails" TEXT;

-- CreateTable
CREATE TABLE "BuyerShowingCandidate" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceInteractionId" TEXT,
    "sourceConversationId" TEXT,
    "clientId" TEXT NOT NULL,
    "agentId" TEXT,
    "assignmentAt" TIMESTAMP(3) NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL,
    "propertyId" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewDueAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "executionMode" TEXT NOT NULL DEFAULT 'PREVIEW',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "taskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerShowingCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuyerShowingCandidate_sourceKey_key" ON "BuyerShowingCandidate"("sourceKey");

-- CreateIndex
CREATE INDEX "BuyerShowingCandidate_clientId_status_idx" ON "BuyerShowingCandidate"("clientId", "status");

-- CreateIndex
CREATE INDEX "BuyerShowingCandidate_status_reviewDueAt_idx" ON "BuyerShowingCandidate"("status", "reviewDueAt");

