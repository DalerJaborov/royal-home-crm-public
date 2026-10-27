CREATE TABLE "SomonMonitor" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "activatedAt" TIMESTAMP(3),
  "baselineAt" TIMESTAMP(3),
  "baselineNextPage" INTEGER NOT NULL DEFAULT 1,
  "baselineLastPage" INTEGER,
  "nextScanAt" TIMESTAMP(3),
  "scanPage" INTEGER NOT NULL DEFAULT 1,
  "scanRegularPage" INTEGER,
  "scanLeaseToken" TEXT,
  "scanLeaseUntil" TIMESTAMP(3),
  "contactKeyFingerprint" TEXT,
  "lastAssignedAgentId" TEXT,
  "blockedUntil" TIMESTAMP(3),
  "requestLeaseUntil" TIMESTAMP(3),
  "requestLeaseToken" TEXT,
  "sourceStopped" BOOLEAN NOT NULL DEFAULT false,
  "sourceFailures" INTEGER NOT NULL DEFAULT 0,
  "sourceLastFailureAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SomonMonitor_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SomonRecipient" (
  "agentId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "SomonRecipient_pkey" PRIMARY KEY ("agentId")
);
CREATE UNIQUE INDEX "SomonRecipient_position_key" ON "SomonRecipient"("position");
CREATE TABLE "SomonDelivery" (
  "advertId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "dateUncertain" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SomonDelivery_pkey" PRIMARY KEY ("advertId")
);
CREATE INDEX "SomonDelivery_status_updatedAt_idx" ON "SomonDelivery"("status", "updatedAt");
CREATE TABLE "SomonSeenAdvert" (
  "advertId" TEXT NOT NULL,
  "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "baseline" BOOLEAN NOT NULL DEFAULT false,
  "slug" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  CONSTRAINT "SomonSeenAdvert_pkey" PRIMARY KEY ("advertId")
);
CREATE INDEX "SomonSeenAdvert_seenAt_idx" ON "SomonSeenAdvert"("seenAt");
CREATE TABLE "SomonContactReceipt" (
  "phoneHash" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "advertId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SomonContactReceipt_pkey" PRIMARY KEY ("phoneHash")
);
CREATE UNIQUE INDEX "SomonContactReceipt_advertId_key" ON "SomonContactReceipt"("advertId");
