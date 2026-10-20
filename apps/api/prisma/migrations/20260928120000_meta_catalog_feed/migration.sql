-- Фид каталога Meta для рекламы (Advantage+ catalog ads, home_listings, 28.09.2026).
-- metaCatalogFeedKey NULL по умолчанию (ключ не сгенерирован) — не секрет, не шифруется.
ALTER TABLE "Settings" ADD COLUMN "metaCatalogFeedKey" TEXT;
ALTER TABLE "Settings" ADD COLUMN "metaCatalogFeedEnabled" BOOLEAN NOT NULL DEFAULT false;
