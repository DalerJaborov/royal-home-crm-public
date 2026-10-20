-- Учёт расходов на рекламу по объектам: объявление (Ad) + расход за день (AdSpendDaily).
-- Ни одна существующая таблица не меняется, кроме Settings, куда добавляются
-- выключенный по умолчанию рубильник и поля доступа к рекламному кабинету, —
-- применение миграции ничего в работающей CRM не включает.

-- CreateEnum
CREATE TYPE "AdPlatform" AS ENUM ('META', 'GOOGLE', 'TIKTOK', 'MANUAL');

-- CreateEnum
CREATE TYPE "AdMatchSource" AS ENUM ('POST_URL', 'FEED_CAPTION', 'ENTITY_NAME', 'MANUAL');

-- CreateTable
CREATE TABLE "Ad" (
    "id" TEXT NOT NULL,
    "platform" "AdPlatform" NOT NULL DEFAULT 'META',
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "campaignId" TEXT,
    "campaignName" TEXT,
    "adsetId" TEXT,
    "adsetName" TEXT,
    "postUrl" TEXT,
    "postShortcode" TEXT,
    "mediaId" TEXT,
    "thumbnailUrl" TEXT,
    "propertyId" TEXT,
    "matchSource" "AdMatchSource",
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdSpendDaily" (
    "id" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "spend" DECIMAL(12,2) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'USD',
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "conversations" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdSpendDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ad_platform_externalId_key" ON "Ad"("platform", "externalId");

-- CreateIndex
CREATE INDEX "Ad_propertyId_idx" ON "Ad"("propertyId");

-- CreateIndex
CREATE INDEX "Ad_postShortcode_idx" ON "Ad"("postShortcode");

-- CreateIndex
CREATE UNIQUE INDEX "AdSpendDaily_adId_date_key" ON "AdSpendDaily"("adId", "date");

-- CreateIndex
CREATE INDEX "AdSpendDaily_date_idx" ON "AdSpendDaily"("date");

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdSpendDaily" ADD CONSTRAINT "AdSpendDaily_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "metaAdsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "metaAdsToken" TEXT,
ADD COLUMN     "metaAdsTokenRefreshedAt" TIMESTAMP(3),
ADD COLUMN     "metaAdAccountId" TEXT,
ADD COLUMN     "metaAdsSyncedAt" TIMESTAMP(3);
