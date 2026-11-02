-- Рынок (02.11.2026): поля для подбора ПОХОЖИХ объявлений. Только добавление колонок.
ALTER TABLE "MarketListing"
  ADD COLUMN "repair" TEXT,
  ADD COLUMN "buildingType" TEXT,
  ADD COLUMN "isNewBuilding" BOOLEAN,
  ADD COLUMN "buildingReady" BOOLEAN,
  ADD COLUMN "exchangePossible" BOOLEAN,
  ADD COLUMN "latitude" DECIMAL(65,30),
  ADD COLUMN "longitude" DECIMAL(65,30),
  ADD COLUMN "publishedAt" TIMESTAMP(3);
