-- Рубильник перезвона клиента из Корзины (17.11.2026). Аддитивно, выключен по умолчанию.
ALTER TABLE "Settings" ADD COLUMN "incomingArchiveCallbackEnabled" BOOLEAN NOT NULL DEFAULT false;
