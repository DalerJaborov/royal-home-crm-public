-- CreateEnum
CREATE TYPE "PostShowingCallStatus" AS ENUM ('PENDING', 'CALLING', 'DONE', 'NO_ANSWER', 'GIVEN_UP', 'SKIPPED');

-- CreateEnum
CREATE TYPE "PostShowingCallOutcome" AS ENUM ('LIKED', 'NOT_SUITABLE', 'THINKING', 'NO_MEETING', 'AGENT_COMPLAINT', 'BYPASS', 'REFUSED', 'UNCLEAR');

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "postShowingCallEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PostShowingCall" (
    "id" TEXT NOT NULL,
    "showingId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "propertyId" TEXT,
    "status" "PostShowingCallStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "channelId" TEXT,
    "talkedAt" TIMESTAMP(3),
    "outcome" "PostShowingCallOutcome",
    "outcomeConfidence" DOUBLE PRECISION,
    "quote" TEXT,
    "redFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "summary" TEXT,
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostShowingCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PostShowingCall_showingId_key" ON "PostShowingCall"("showingId");

-- CreateIndex
CREATE INDEX "PostShowingCall_status_scheduledFor_idx" ON "PostShowingCall"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "PostShowingCall_clientId_createdAt_idx" ON "PostShowingCall"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "PostShowingCall_agentId_createdAt_idx" ON "PostShowingCall"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "PostShowingCall_channelId_idx" ON "PostShowingCall"("channelId");

-- AddForeignKey
ALTER TABLE "PostShowingCall" ADD CONSTRAINT "PostShowingCall_showingId_fkey" FOREIGN KEY ("showingId") REFERENCES "Interaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostShowingCall" ADD CONSTRAINT "PostShowingCall_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostShowingCall" ADD CONSTRAINT "PostShowingCall_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostShowingCall" ADD CONSTRAINT "PostShowingCall_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

