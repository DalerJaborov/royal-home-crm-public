-- СЛОЙ ОБУЧЕНИЯ «СТУДИИ ЗАПУСКА РЕКЛАМЫ» (04.10.2026) — только добавление: одна новая
-- таблица настроек группы объявлений, считанных из Meta. Ничего существующего не меняется.

CREATE TABLE "AdSetSettings" (
    "id" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "adsetId" TEXT,
    "destination" TEXT,
    "optimizationGoal" TEXT,
    "bidStrategy" TEXT,
    "billingEvent" TEXT,
    "dailyBudgetCents" INTEGER,
    "lifetimeBudgetCents" INTEGER,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "durationDays" INTEGER,
    "geoScope" TEXT,
    "geoRaw" JSONB,
    "ageMin" INTEGER,
    "ageMax" INTEGER,
    "genders" INTEGER[],
    "advantageAudience" BOOLEAN,
    "placementsMode" TEXT,
    "platforms" TEXT[],
    "promotedObject" JSONB,
    "rawTargeting" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdSetSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdSetSettings_adId_key" ON "AdSetSettings"("adId");

ALTER TABLE "AdSetSettings" ADD CONSTRAINT "AdSetSettings_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE CASCADE ON UPDATE CASCADE;
