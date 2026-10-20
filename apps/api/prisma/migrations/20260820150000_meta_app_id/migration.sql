-- Номер приложения Meta: нужен для обмена короткого маркера рекламного кабинета
-- на 60-дневный и его продления (lib/ads/metaAdsToken.ts). Не секрет.
ALTER TABLE "Settings" ADD COLUMN "metaAppId" TEXT;
