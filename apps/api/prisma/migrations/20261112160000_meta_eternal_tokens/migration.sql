-- Вечные ключи Meta (12.11.2026): Страница Facebook у аккаунта Instagram и
-- рубильник «брать маркер от системного пользователя». Только добавление
-- колонок с безопасным умолчанием: старый код их не читает, откат не нужен.
ALTER TABLE "MessengerAccount" ADD COLUMN "pageId" TEXT;
ALTER TABLE "Settings" ADD COLUMN "metaSystemTokenPreferred" BOOLEAN NOT NULL DEFAULT true;
