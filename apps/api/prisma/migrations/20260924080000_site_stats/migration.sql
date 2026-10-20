-- Статистика сайта royalhome.tj: посещаемость по часам и объект по дням (24.09.2026).
CREATE TABLE "SiteVisitHour" (
    "hourStart" TIMESTAMP(3) NOT NULL,
    "views" INTEGER NOT NULL,
    "visitors" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteVisitHour_pkey" PRIMARY KEY ("hourStart")
);

CREATE TABLE "SitePropertyDay" (
    "propertyId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "visitors" INTEGER NOT NULL DEFAULT 0,
    "phoneClicks" INTEGER NOT NULL DEFAULT 0,
    "whatsappClicks" INTEGER NOT NULL DEFAULT 0,
    "telegramClicks" INTEGER NOT NULL DEFAULT 0,
    "shareClicks" INTEGER NOT NULL DEFAULT 0,
    "favoriteClicks" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SitePropertyDay_pkey" PRIMARY KEY ("propertyId","day")
);

CREATE INDEX "SitePropertyDay_day_idx" ON "SitePropertyDay"("day");

ALTER TABLE "SitePropertyDay" ADD CONSTRAINT "SitePropertyDay_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
