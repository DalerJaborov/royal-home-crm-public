-- Рубильник «Кнопка «Записать результат» в карточке клиента» (владелец 22.11.2026): по умолчанию ВЫКЛ, только новая колонка.
ALTER TABLE "Settings" ADD COLUMN "clientRecordResultEnabled" BOOLEAN NOT NULL DEFAULT false;
