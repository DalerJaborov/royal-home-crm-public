-- Рубильник «Бот отказывает, если объект не в Душанбе» (28.11.2026), по умолчанию ВЫКЛ (решение владельца 19.11).
ALTER TABLE "Settings" ADD COLUMN "botOutOfAreaRefusalEnabled" BOOLEAN NOT NULL DEFAULT false;
