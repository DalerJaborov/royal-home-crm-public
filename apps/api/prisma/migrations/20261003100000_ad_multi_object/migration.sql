-- ОДНО ОБЪЯВЛЕНИЕ — НЕСКОЛЬКО ОБЪЕКТОВ (03.10.2026).
-- «Гибкое» объявление Meta несёт несколько роликов про разные квартиры, а CRM
-- привязывала его к одному объекту и весь расход писала на него. Теперь доли
-- объектов лежат в AdProperty; Ad.propertyId остаётся «основным объектом».
-- Миграция аддитивная: ничего не удаляется, старые строки получают одну долю.

-- Материалы объявления и их число. По умолчанию 1: объявление без разобранного
-- креатива — это один материал.
ALTER TABLE "Ad" ADD COLUMN "creativeAssets" JSONB;
ALTER TABLE "Ad" ADD COLUMN "assetCount" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "AdProperty" (
    "id" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "weight" DECIMAL(8,3) NOT NULL DEFAULT 1,
    "source" "AdMatchSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdProperty_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdProperty_adId_propertyId_key" ON "AdProperty"("adId", "propertyId");
CREATE INDEX "AdProperty_propertyId_idx" ON "AdProperty"("propertyId");

ALTER TABLE "AdProperty" ADD CONSTRAINT "AdProperty_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdProperty" ADD CONSTRAINT "AdProperty_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Бэкфилл: каждое привязанное объявление получает одну долю с весом 1. Источник —
-- тот, что стоял в matchSource; у строк без него (заведены вручную до появления
-- поля) считаем прямой привязкой по публикации.
INSERT INTO "AdProperty" ("id", "adId", "propertyId", "weight", "source")
SELECT gen_random_uuid()::text, a."id", a."propertyId", 1, COALESCE(a."matchSource", 'POST_URL'::"AdMatchSource")
FROM "Ad" a
WHERE a."propertyId" IS NOT NULL
ON CONFLICT ("adId", "propertyId") DO NOTHING;
