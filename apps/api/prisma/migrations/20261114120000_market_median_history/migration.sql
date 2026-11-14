-- История медиан рынка по сегментам (14.11.2026): только новая таблица и индексы, существующее не трогаем.
CREATE TABLE "MarketMedianDaily" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "districtName" TEXT NOT NULL,
    "rooms" INTEGER NOT NULL,
    "building" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "medianPerSqmTjs" INTEGER,
    "averagePerSqmTjs" INTEGER,
    "medianPriceTjs" INTEGER,
    "averagePriceTjs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketMedianDaily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarketMedianDaily_day_city_districtName_rooms_building_audience_key" ON "MarketMedianDaily"("day", "city", "districtName", "rooms", "building", "audience");

CREATE INDEX "MarketMedianDaily_city_districtName_rooms_building_audience_day_idx" ON "MarketMedianDaily"("city", "districtName", "rooms", "building", "audience", "day");
