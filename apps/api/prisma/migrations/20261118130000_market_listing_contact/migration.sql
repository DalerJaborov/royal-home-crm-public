-- Кто уже связывался с продавцом чужого объявления (17.11.2026): только добавление таблицы.
CREATE TABLE "MarketListingContact" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "clientId" TEXT,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketListingContact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MarketListingContact_listingId_createdAt_idx" ON "MarketListingContact"("listingId", "createdAt");
CREATE INDEX "MarketListingContact_agentId_createdAt_idx" ON "MarketListingContact"("agentId", "createdAt");
ALTER TABLE "MarketListingContact" ADD CONSTRAINT "MarketListingContact_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
