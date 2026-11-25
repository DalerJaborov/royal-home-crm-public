-- Реестр строек (25.11.2026): агенту один раз сообщаем, что его объект связан с проектом жёлтого или красного цвета.
-- notifiedAt — когда событие «связали» обработано (уведомление отправлено или цвет зелёный); повтор не шлём.
-- Только новая колонка. Уже существующие связи отмечаются обработанными, чтобы выкат не разослал задним числом.
ALTER TABLE "ConstructionPropertyLink" ADD COLUMN "notifiedAt" TIMESTAMP(3);
UPDATE "ConstructionPropertyLink" SET "notifiedAt" = CURRENT_TIMESTAMP WHERE "state" = 'LINKED';
