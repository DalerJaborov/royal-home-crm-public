-- Выключатели автоматики «работа с продавцами» (владелец 14.11.2026). Только новые колонки,
-- все включены по умолчанию: поведение после выката не меняется, выключает человек в Настройках.
ALTER TABLE "Settings" ADD COLUMN "sellerAutomationMasterEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "sellerNoPropertyAlarmEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "sellerPropertyMissingAntifraudEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "agentUnansweredAlarmEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "dealStaleSellersEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "sellerProbeCallEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "dealAfterCloseMessagesEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "sellerAiAnalysisEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "morningSellerLinesEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "sellerWorkStalledAlarmEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "clientPropertyCountAlarmEnabled" BOOLEAN NOT NULL DEFAULT true;
