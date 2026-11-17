-- Рынок (02.11.2026): совпадения наших объектов с объявлениями Somon/Paydo. Только CREATE TABLE/INDEX/FK, существующие таблицы не меняются.
-- CreateTable
CREATE TABLE "PropertyMarketMatch" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "foundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    "lastPriceTjs" DECIMAL(65,30),
    "goneNotifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyMarketMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyMarketMatch_propertyId_status_idx" ON "PropertyMarketMatch"("propertyId", "status");

-- CreateIndex
CREATE INDEX "PropertyMarketMatch_listingId_idx" ON "PropertyMarketMatch"("listingId");

-- CreateIndex
CREATE INDEX "PropertyMarketMatch_status_notifiedAt_idx" ON "PropertyMarketMatch"("status", "notifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyMarketMatch_propertyId_listingId_key" ON "PropertyMarketMatch"("propertyId", "listingId");

-- AddForeignKey
ALTER TABLE "PropertyMarketMatch" ADD CONSTRAINT "PropertyMarketMatch_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyMarketMatch" ADD CONSTRAINT "PropertyMarketMatch_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

