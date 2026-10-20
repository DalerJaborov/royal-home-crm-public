-- Обратный синк сайт→CRM: связь объекта CRM с листингом на сайте.
ALTER TABLE "Property" ADD COLUMN "siteListingId" INTEGER;
CREATE UNIQUE INDEX "Property_siteListingId_key" ON "Property"("siteListingId");
