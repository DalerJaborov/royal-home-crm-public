-- Ночной поиск двойных досье по слабым признакам: выключен по умолчанию.
ALTER TABLE "Settings" ADD COLUMN "contactLinkSweepEnabled" BOOLEAN NOT NULL DEFAULT false;
