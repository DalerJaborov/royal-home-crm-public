-- Место для Google Ads и Яндекс Директа (значение enum) и секрет для приёма
-- бюджетных оповещений Google Cloud. Существующие данные не затрагиваются.
ALTER TYPE "AdPlatform" ADD VALUE IF NOT EXISTS 'YANDEX';
ALTER TABLE "Settings" ADD COLUMN "googleBudgetToken" TEXT;
