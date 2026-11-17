-- Узкий подбор с площадок под покупателя (17.11.2026): пороги — настройки компании.
ALTER TABLE "Settings" ADD COLUMN "marketBuyerFreshDays" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Settings" ADD COLUMN "marketBuyerBudgetTolerancePct" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "Settings" ADD COLUMN "marketBuyerRoomsTolerance" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Settings" ADD COLUMN "marketBuyerAlertsPerDay" INTEGER NOT NULL DEFAULT 3;
