-- Владелец 16.11.2026 (вечер): старые «Потерянные» — обратно в обычный список.
-- Состояния «Потерянный» больше нет: код его не ставит, экраны не показывают.
-- Карточки, которые уже стояли в LOST, становятся обычными клиентами в работе:
--   * с первым контактом (firstContactAt задан) — CONTACTED («На контакте»);
--   * без него — NEW.
-- ARCHIVED не трогаем: архив владелец считает той же корзиной.
--
-- Неразрушающе и повторяемо:
--   * колонки не меняются, lostAt и refusalCount остаются как история;
--   * каждое изменение пишется строкой в журнал переходов "StageEvent"
--     (field = 'status', from = 'LOST') — по нему видно, кто где стоял;
--   * повторный запуск ничего не находит и ничего не делает.
WITH moved AS (
  SELECT "id",
         CASE WHEN "firstContactAt" IS NOT NULL THEN 'CONTACTED' ELSE 'NEW' END AS "toStatus"
  FROM "Client"
  WHERE "status" = 'LOST'
  FOR UPDATE
),
logged AS (
  INSERT INTO "StageEvent" ("id", "entityType", "entityId", "field", "from", "to", "agentId", "at")
  SELECT gen_random_uuid()::text, 'CLIENT', m."id", 'status', 'LOST', m."toStatus", NULL, now()
  FROM moved m
  RETURNING 1
)
UPDATE "Client" c
SET "status" = m."toStatus"::"ClientStatus"
FROM moved m
WHERE c."id" = m."id";
