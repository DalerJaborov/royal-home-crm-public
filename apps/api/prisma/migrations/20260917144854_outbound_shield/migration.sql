-- CreateTable
CREATE TABLE "OutboundShieldState" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "recipientName" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "lastInboundId" TEXT,
    "botSentSinceInbound" INTEGER NOT NULL DEFAULT 0,
    "hourWindowStart" TIMESTAMP(3),
    "hourCount" INTEGER NOT NULL DEFAULT 0,
    "dayWindowStart" TIMESTAMP(3),
    "dayCount" INTEGER NOT NULL DEFAULT 0,
    "recentTexts" JSONB NOT NULL DEFAULT '[]',
    "pausedUntil" TIMESTAMP(3),
    "pausedReason" TEXT,
    "pausedAt" TIMESTAMP(3),
    "loggedAt" TIMESTAMP(3),
    "alertedAt" TIMESTAMP(3),
    "firedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundShieldState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundShieldPulse" (
    "bucket" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OutboundShieldPulse_pkey" PRIMARY KEY ("bucket")
);

-- CreateTable
CREATE TABLE "OutboundShieldGlobal" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "pausedUntil" TIMESTAMP(3),
    "reason" TEXT,
    "alertedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundShieldGlobal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboundShieldState_pausedUntil_idx" ON "OutboundShieldState"("pausedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundShieldState_channel_subscriberId_key" ON "OutboundShieldState"("channel", "subscriberId");
