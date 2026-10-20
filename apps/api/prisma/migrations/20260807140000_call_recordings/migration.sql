-- Запись телефонного разговора у записи в хронологии клиента.
--
-- recordingUrl — КЛЮЧ объекта в R2, а не готовая ссылка: ссылка подписывается на
-- 10 минут в момент клика (lib/r2Client.ts). Постоянный URL на разговор клиента с
-- агентом жил бы вечно в чужой переписке.
-- transcript — текст от Gemini, приходит позже записи (расшифровка идёт очередью).
-- recordingDurationSec — секунды разговора из callTracker, а не длина файла.
--
-- SQL написан вручную, а не сгенерирован `migrate diff`: генератор дополнительно
-- удаляет индексы pg_trgm (Client_fullName_trgm_idx и соседние), созданные отдельной
-- миграцией 20260805160000_pg_trgm_fuzzy_search и не описанные в schema.prisma. Их
-- удаление сломало бы опечатко-устойчивый поиск по клиентам и объектам.
--
-- Все три колонки NULL-овые: старые звонки записи не имеют и иметь не будут,
-- значений по умолчанию тут быть не должно.
ALTER TABLE "Interaction" ADD COLUMN "recordingUrl" TEXT;
ALTER TABLE "Interaction" ADD COLUMN "transcript" TEXT;
ALTER TABLE "Interaction" ADD COLUMN "recordingDurationSec" INTEGER;
