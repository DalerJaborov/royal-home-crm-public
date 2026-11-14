-- Вечные ключи Meta (12.11.2026): Страница Facebook у аккаунта Instagram, отметка
-- последней успешной отправки через Страницу, рубильник и отметка «App Review
-- одобрен». Только добавление колонок; оба флажка ВЫКЛЮЧЕНЫ — и для новой, и для
-- существующей строки Settings: путь через Страницу без одобрения Meta отвечает
-- только людям с ролью в приложении.
ALTER TABLE "MessengerAccount" ADD COLUMN "pageId" TEXT;
ALTER TABLE "MessengerAccount" ADD COLUMN "eternalLastSentAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "metaSystemTokenPreferred" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "metaAppReviewApproved" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "metaPageEternalLastSentAt" TIMESTAMP(3);
