-- AlterTable
ALTER TABLE "OwnerReportDelivery" ADD COLUMN     "claimStartedAt" TIMESTAMP(3),
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "executionMode" TEXT NOT NULL DEFAULT 'PREVIEW',
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "providerReceipt" JSONB,
ADD COLUMN     "recipientHash" TEXT,
ADD COLUMN     "subscriptionVersion" INTEGER;

-- AlterTable
ALTER TABLE "PropertyNarrationDelivery" ADD COLUMN     "claimStartedAt" TIMESTAMP(3),
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "executionMode" TEXT NOT NULL DEFAULT 'PREVIEW',
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "plan" JSONB,
ADD COLUMN     "receipts" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "PublicationMetadataSync" ADD COLUMN     "attemptedById" TEXT,
ADD COLUMN     "executionMode" TEXT NOT NULL DEFAULT 'PREVIEW',
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "result" JSONB,
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "sellerControlConfig" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "OwnerReportSubscription" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "sellerClientId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "executionMode" TEXT NOT NULL DEFAULT 'PREVIEW',
    "consentAt" TIMESTAMP(3),
    "consentById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerReportSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerControlEpisode" (
    "id" TEXT NOT NULL,
    "episodeKey" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "assignmentAt" TIMESTAMP(3) NOT NULL,
    "agentId" TEXT,
    "expectedCount" INTEGER,
    "baselineAccepted" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'AGENT_TASK',
    "executionMode" TEXT NOT NULL DEFAULT 'PREVIEW',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "sourceFingerprint" TEXT,
    "agentTaskId" TEXT,
    "ropTaskId" TEXT,
    "ropAgentId" TEXT,
    "agentDueAt" TIMESTAMP(3),
    "ropReceiptDueAt" TIMESTAMP(3),
    "ropReceiptAt" TIMESTAMP(3),
    "ropActionDueAt" TIMESTAMP(3),
    "ropDueAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerControlEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerControlEvent" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "SellerControlEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualDataCorrection" (
    "id" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "planHash" TEXT NOT NULL,
    "targets" JSONB NOT NULL,
    "impact" JSONB NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "ManualDataCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnerReportSubscription_propertyId_key" ON "OwnerReportSubscription"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerControlEpisode_episodeKey_key" ON "SellerControlEpisode"("episodeKey");

-- CreateIndex
CREATE UNIQUE INDEX "SellerControlEpisode_agentTaskId_key" ON "SellerControlEpisode"("agentTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerControlEpisode_ropTaskId_key" ON "SellerControlEpisode"("ropTaskId");

-- CreateIndex
CREATE INDEX "SellerControlEpisode_clientId_status_idx" ON "SellerControlEpisode"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SellerControlEvent_requestKey_key" ON "SellerControlEvent"("requestKey");

-- CreateIndex
CREATE INDEX "SellerControlEvent_episodeId_occurredAt_idx" ON "SellerControlEvent"("episodeId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ManualDataCorrection_requestKey_key" ON "ManualDataCorrection"("requestKey");

-- AddForeignKey
ALTER TABLE "OwnerReportSubscription" ADD CONSTRAINT "OwnerReportSubscription_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerControlEvent" ADD CONSTRAINT "SellerControlEvent_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "SellerControlEpisode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

