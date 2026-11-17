-- Владелец 16.11.2026 (вечер), доводка миграции 20261116160000_client_lost_back_to_work.
-- Бывшие «Потерянные» сменили статус, но не вернулись в список «в работе»: отказ
-- закрывал работу агента отметкой "assignmentCompletedAt", а список в работе
-- (lib/clientInWork.ts) требует её пустой. Здесь отметка снимается.
--
-- Заодно "lostAt" заполняется там, где его не было: это история, и по ней утренняя
-- раздача отличает бывшую «потерянную» от новой заявки и не рассылает её агентам
-- как «новый лид с ночи» (services/leads/reassignment.ts::newLeadOnlyWhere).
--
-- Кого трогаем — только карточки, которые прежняя миграция перевела из LOST
-- (строка журнала "StageEvent": field = 'status', from = 'LOST', без агента).
-- ARCHIVED и Корзину не трогаем. Повторный запуск ничего не меняет: условие
-- отбирает только карточки, где ещё есть что исправить.
UPDATE "Client" c
SET "assignmentCompletedAt" = NULL,
    "lostAt" = COALESCE(c."lostAt", c."updatedAt")
WHERE c."deletedAt" IS NULL
  AND c."status" IN ('NEW', 'CONTACTED')
  AND (c."assignmentCompletedAt" IS NOT NULL OR c."lostAt" IS NULL)
  AND EXISTS (
    SELECT 1 FROM "StageEvent" e
    WHERE e."entityType" = 'CLIENT'
      AND e."entityId" = c."id"
      AND e."field" = 'status'
      AND e."from" = 'LOST'
      AND e."agentId" IS NULL
  );
