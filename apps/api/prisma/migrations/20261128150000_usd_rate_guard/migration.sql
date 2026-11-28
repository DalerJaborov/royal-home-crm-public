-- Страж курса доллара (владелец 28.11.2026). Только добавляет колонки, данные не трогает.
ALTER TABLE "Settings" ADD COLUMN "usdRatePendingValue" DECIMAL(65,30);
ALTER TABLE "Settings" ADD COLUMN "usdRatePendingAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "usdRateSyncedRate" DECIMAL(65,30);
ALTER TABLE "Settings" ADD COLUMN "usdRateStaleAlertedAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "usdRateAlertPct" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "Settings" ADD COLUMN "usdRateSiteResyncEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "usdRateAlertsEnabled" BOOLEAN NOT NULL DEFAULT true;
