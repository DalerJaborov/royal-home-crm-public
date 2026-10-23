-- Автопродвижение роликов в Meta (23.10.2026). Всё выключено по умолчанию, пробный режим включён.
ALTER TABLE "Settings" ADD COLUMN "reelsAutoBoostEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "reelsAutoBoostDryRun" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "reelsAutoBoostAdSetId" TEXT;
ALTER TABLE "Settings" ADD COLUMN "reelsAutoBoostMaxActive" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Settings" ADD COLUMN "reelsAutoBoostMaxAgeDays" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "Settings" ADD COLUMN "reelsAutoBoostStopLossSpendUsd" DECIMAL(10,2) NOT NULL DEFAULT 4;
ALTER TABLE "Settings" ADD COLUMN "reelsAutoBoostCtaType" TEXT NOT NULL DEFAULT 'WHATSAPP_MESSAGE';

CREATE TYPE "ReelAutoBoostStatus" AS ENUM ('PLANNED', 'ACTIVE', 'PAUSED', 'FAILED', 'SKIPPED');

CREATE TABLE "ReelAutoBoostAd" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "instagramMediaId" TEXT NOT NULL,
    "metaAdId" TEXT,
    "metaCreativeId" TEXT,
    "status" "ReelAutoBoostStatus" NOT NULL DEFAULT 'PLANNED',
    "reason" VARCHAR(500) NOT NULL,
    "spendUsd" DECIMAL(12,2),
    "conversations" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),

    CONSTRAINT "ReelAutoBoostAd_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReelAutoBoostAd_instagramMediaId_key" ON "ReelAutoBoostAd"("instagramMediaId");
CREATE INDEX "ReelAutoBoostAd_status_createdAt_idx" ON "ReelAutoBoostAd"("status", "createdAt");
CREATE INDEX "ReelAutoBoostAd_propertyId_idx" ON "ReelAutoBoostAd"("propertyId");

ALTER TABLE "ReelAutoBoostAd" ADD CONSTRAINT "ReelAutoBoostAd_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
