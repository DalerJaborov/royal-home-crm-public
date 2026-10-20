-- Messenger (Страница Facebook) как третий канал Meta рядом с WhatsApp и Instagram.
-- Маркер Страницы — секрет, шифруется как остальные; идентификатор Страницы
-- хранится как есть, он публичный.

ALTER TABLE "Settings" ADD COLUMN "metaPageToken" TEXT;
ALTER TABLE "Settings" ADD COLUMN "metaPageId" TEXT;
