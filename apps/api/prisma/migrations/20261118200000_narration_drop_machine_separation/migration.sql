-- 18.11.2026, решение владельца: машинное отделение старого голоса (сервис voice-separator,
-- lib/narrationAutoMaster.ts) убрано целиком — на проде голос не убрало ни разу.
--
-- 1. Мастер, сделанный машиной, мог сохранить старый голос: перемикс из него наложил бы новый
--    голос поверх старого. Такие мастера больше не используются — следующая смена цены идёт
--    прежним путём (монтажёр) или, когда включат, своей музыкой. Файлы мастеров остаются на диске.
UPDATE "Property"
SET "videoMasterStorageKey" = NULL, "videoMasterSource" = NULL
WHERE "videoMasterSource" = 'MACHINE';

-- 2. Служебные поля машины.
ALTER TABLE "Property" DROP COLUMN "videoMasterAutoError";
ALTER TABLE "Property" DROP COLUMN "videoMasterAutoErrorFinalPath";
ALTER TABLE "Property" DROP COLUMN "videoMasterAutoAttempts";
ALTER TABLE "Property" DROP COLUMN "videoMasterAutoRetryAt";
