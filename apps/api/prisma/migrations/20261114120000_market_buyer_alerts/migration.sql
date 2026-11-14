-- Пуш агенту «новое объявление Somon/Paydo подошло вашему покупателю» (14.11.2026).
-- Только добавление: новая таблица и одна колонка с безопасным значением. Рубильник ВЫКЛЮЧЕН для
-- существующей и новой строки Settings, поэтому после выката ничего не меняется, пока его не включат.
ALTER TABLE "Settings" ADD COLUMN "marketBuyerAlertsEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "BuyerMarketAlert" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerMarketAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BuyerMarketAlert_clientId_listingId_key" ON "BuyerMarketAlert"("clientId", "listingId");
CREATE INDEX "BuyerMarketAlert_clientId_notifiedAt_idx" ON "BuyerMarketAlert"("clientId", "notifiedAt");
CREATE INDEX "BuyerMarketAlert_listingId_idx" ON "BuyerMarketAlert"("listingId");

ALTER TABLE "BuyerMarketAlert" ADD CONSTRAINT "BuyerMarketAlert_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BuyerMarketAlert" ADD CONSTRAINT "BuyerMarketAlert_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
