-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "declinedAgentIds" JSONB NOT NULL DEFAULT '[]';

-- Бэкфилл (ПР-000477, 25.09.2026): отказы, случившиеся ДО этого поля, не должны
-- потеряться — иначе агент, отказавшийся от лида вчера, сегодня снова получил бы
-- его же карусель по кругу. Источник — AuditLog(action='LEAD_DECLINE'), тот же
-- журнал, что и раньше писал routes/clients/lifecycle.ts::POST /:id/decline
-- (meta->>'agentId' — кто отказался). Ограничено НЕпринятыми и неудалёнными
-- клиентами: у принятого лида «Отказ» уже неприменим (declineLead запрещает его
-- после acceptedAt), а Корзина — не рабочая очередь.
--
-- Отказы через кнопку в шторке пуша (routes/push.ts, мимо этого маршрута)
-- аудит-лог не пишут вовсе — этот класс истории физически не восстановить, и
-- бэкфилл его не покрывает: разовая миграция признаёт частичное восстановление
-- лучше, чем полное молчание.
UPDATE "Client" c
SET "declinedAgentIds" = COALESCE(agg.ids, '[]'::jsonb)
FROM (
  SELECT a."entityId" AS client_id, jsonb_agg(DISTINCT a.meta->>'agentId') AS ids
  FROM "AuditLog" a
  WHERE a.action = 'LEAD_DECLINE' AND a.meta->>'agentId' IS NOT NULL
  GROUP BY a."entityId"
) agg
WHERE c.id = agg.client_id
  AND c."acceptedAt" IS NULL
  AND c."deletedAt" IS NULL;
