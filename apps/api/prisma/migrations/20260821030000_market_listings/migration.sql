-- Рыночная разведка (владелец 21.08.2026): своя копия чужих объявлений.
-- Обе таблицы новые, существующих данных не касаются.

CREATE TABLE "MarketListing" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "dealType" TEXT NOT NULL,
    "propertyType" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "districtName" TEXT,
    "landmark" TEXT,
    "rooms" INTEGER,
    "areaSqm" DECIMAL(65,30),
    "floor" INTEGER,
    "totalFloors" INTEGER,
    "price" DECIMAL(65,30),
    "currency" TEXT NOT NULL,
    "priceTjs" DECIMAL(65,30),
    "pricePerSqmTjs" DECIMAL(65,30),
    "negotiable" BOOLEAN NOT NULL DEFAULT false,
    "sellerId" TEXT,
    "sellerName" TEXT,
    "isAgency" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL,
    "photoCount" INTEGER NOT NULL DEFAULT 0,
    "hasVideo" BOOLEAN NOT NULL DEFAULT false,
    "isPromoted" BOOLEAN NOT NULL DEFAULT false,
    "publishedText" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "disappearedAt" TIMESTAMP(3),
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketListing_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketPriceSnapshot" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "priceTjs" DECIMAL(65,30) NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketPriceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarketListing_source_sourceId_key" ON "MarketListing"("source", "sourceId");
CREATE INDEX "MarketListing_dealType_propertyType_isActive_idx" ON "MarketListing"("dealType", "propertyType", "isActive");
CREATE INDEX "MarketListing_city_districtName_rooms_idx" ON "MarketListing"("city", "districtName", "rooms");
CREATE INDEX "MarketListing_pricePerSqmTjs_idx" ON "MarketListing"("pricePerSqmTjs");
CREATE INDEX "MarketListing_lastSeenAt_idx" ON "MarketListing"("lastSeenAt");
CREATE INDEX "MarketListing_sellerId_idx" ON "MarketListing"("sellerId");
CREATE INDEX "MarketPriceSnapshot_listingId_seenAt_idx" ON "MarketPriceSnapshot"("listingId", "seenAt");

ALTER TABLE "MarketPriceSnapshot" ADD CONSTRAINT "MarketPriceSnapshot_listingId_fkey"
    FOREIGN KEY ("listingId") REFERENCES "MarketListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
