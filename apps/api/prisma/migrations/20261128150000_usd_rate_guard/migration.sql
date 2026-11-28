-- Страж курса доллара (владелец 28.11.2026). Только добавляет колонки, данные не трогает.
ALTER TABLE "Settings" ADD COLUMN "usdRatePendingValue" DECIMAL(65,30);
ALTER TABLE "Settings" ADD COLUMN "usdRatePendingAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "usdRateSyncedRate" DECIMAL(65,30);
ALTER TABLE "Settings" ADD COLUMN "usdRateStaleAlertedAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "usdRateAlertPct" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "Settings" ADD COLUMN "usdRateSiteResyncEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "usdRateAlertsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "usdRateDismissedValue" DECIMAL(65,30);
-- Порог считается от последнего выровненного курса: на старте это нынешний курс.
UPDATE "Settings" SET "usdRateSyncedRate" = "usdToTjsRate" WHERE "usdRateSyncedRate" IS NULL AND "usdToTjsRate" IS NOT NULL;
