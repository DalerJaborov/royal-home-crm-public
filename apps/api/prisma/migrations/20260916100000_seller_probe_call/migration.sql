-- CreateEnum
CREATE TYPE "SellerProbeCallStatus" AS ENUM ('PENDING', 'CALLING', 'DONE', 'NO_ANSWER', 'GIVEN_UP', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SellerProbeCallOutcome" AS ENUM ('STILL_SELLING', 'SOLD_ELSEWHERE', 'OWNER_CHANGED_MIND', 'REFUSED', 'UNCLEAR');

-- CreateTable
CREATE TABLE "SellerProbeCall" (
    "id" TEXT NOT NULL,
    "postShowingCallId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "sellerClientId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" "SellerProbeCallStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "channelId" TEXT,
    "talkedAt" TIMESTAMP(3),
    "outcome" "SellerProbeCallOutcome",
    "quote" TEXT,
    "summary" TEXT,
    "signals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deadNumber" BOOLEAN NOT NULL DEFAULT false,
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerProbeCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SellerProbeCall_postShowingCallId_key" ON "SellerProbeCall"("postShowingCallId");

-- CreateIndex
CREATE INDEX "SellerProbeCall_status_scheduledFor_idx" ON "SellerProbeCall"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "SellerProbeCall_sellerClientId_idx" ON "SellerProbeCall"("sellerClientId");

-- CreateIndex
CREATE INDEX "SellerProbeCall_agentId_createdAt_idx" ON "SellerProbeCall"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "SellerProbeCall_channelId_idx" ON "SellerProbeCall"("channelId");

-- AddForeignKey
ALTER TABLE "SellerProbeCall" ADD CONSTRAINT "SellerProbeCall_postShowingCallId_fkey" FOREIGN KEY ("postShowingCallId") REFERENCES "PostShowingCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerProbeCall" ADD CONSTRAINT "SellerProbeCall_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerProbeCall" ADD CONSTRAINT "SellerProbeCall_sellerClientId_fkey" FOREIGN KEY ("sellerClientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerProbeCall" ADD CONSTRAINT "SellerProbeCall_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

