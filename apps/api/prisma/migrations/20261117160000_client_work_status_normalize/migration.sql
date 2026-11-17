-- Владелец 16.11.2026: «Неактивных» и «Отложенных» больше нет — клиент просто в
-- списке агента или в Корзине. Код больше не переводит в эти состояния, а те,
-- кто уже в них стоял, возвращаются в обычную работу.
--
-- Неразрушающе и повторяемо:
--   * колонки workStatus / inactive* / deferred* НЕ трогаются (их снимет отдельная
--     миграция позже); меняется только значение workStatus INACTIVE/DEFERRED → ACTIVE;
--   * каждое изменение пишется строкой в журнал переходов "StageEvent"
--     (field = 'workStatus', from = прежнее значение) — по нему можно восстановить,
--     кто где стоял;
--   * повторный запуск ничего не находит и ничего не делает.
--
-- Исключение — карточка, по которой висит предложение «вернуть клиента прежнему
-- агенту» (reactivationOfferedToAgentId задан): там INACTIVE — служебная пометка
-- «предложение не решено», её снимает сам агент кнопкой «принять/отклонить»
-- (lib/reactivationOffers.ts). Сними её миграция — карточку подхватила бы общая
-- раздача мимо прежнего агента.
WITH moved AS (
  SELECT "id", "workStatus"::text AS "fromStatus"
  FROM "Client"
  WHERE "workStatus" IN ('INACTIVE', 'DEFERRED')
    AND "reactivationOfferedToAgentId" IS NULL
  FOR UPDATE
),
logged AS (
  INSERT INTO "StageEvent" ("id", "entityType", "entityId", "field", "from", "to", "agentId", "at")
  SELECT gen_random_uuid()::text, 'CLIENT', m."id", 'workStatus', m."fromStatus", 'ACTIVE', NULL, now()
  FROM moved m
  RETURNING 1
)
UPDATE "Client" c
SET "workStatus" = 'ACTIVE'
FROM moved m
WHERE c."id" = m."id";
