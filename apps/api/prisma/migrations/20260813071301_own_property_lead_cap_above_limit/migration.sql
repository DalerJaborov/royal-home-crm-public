-- AlterTable
ALTER TABLE "Settings" ALTER COLUMN "ownPropertyLeadCap" SET DEFAULT 1;

-- Одна строка-синглтон (id='singleton'). Поле введено 11.08.2026 со значением
-- по умолчанию 0 («без предела») — решением владельца 13.08.2026 смысл поля
-- поменялся на «сколько СВЕРХ activeLimit», новое умолчание 1 (потолок 7).
-- Правим только если поле ещё стоит на старом умолчании: если владелец уже
-- сам поставил другое число руками, трогать его выбор нельзя.
UPDATE "Settings" SET "ownPropertyLeadCap" = 1 WHERE "ownPropertyLeadCap" = 0;
