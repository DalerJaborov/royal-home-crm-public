-- Бэкофилл авторства хронологии + CHECK-ограничение (задание Б1, 17.09.2026,
-- П-10, docs/audit/lead-ownership-17-09.md §2, §4 Р-8;
-- docs/audit/recon-17-09/04-timeline-authorship.md §c).
-- Написано руками (prisma migrate dev запрещён в worktree), сверено со schema.prisma.
--
-- Применяется ПОСЛЕ миграции №1 (2026091722xxxx_interaction_actor_kind,
-- которая добавила actorKind/agentId nullable/subjectAgentId без переноса
-- данных). Здесь — тот же бэкофилл, что делает
-- apps/api/scripts/timeline-backfill-17-09.ts (для ручного/повторного
-- прогона — новый спам-паттерн найдётся, прогнать снова), плюс постоянный
-- CHECK, который эта миграция ставит В КОНЦЕ.
--
-- ПЕРЕКРАСКА ТОЛЬКО ПО ДОКАЗУЕМЫМ ПРИЗНАКАМ (owner: «сомневаешься — не
-- трогаем»). agentId уходит в subjectAgentId, а не пропадает — держатель
-- задачи остаётся виден.

-- 1. SYSTEM — крон/автоматика без участия человека.
UPDATE "Interaction" SET
  "subjectAgentId" = "agentId",
  "agentId" = NULL,
  "actorKind" = 'SYSTEM'
WHERE "actorKind" = 'AGENT' AND "agentId" IS NOT NULL AND (
  notes ~* '^Лид снят и переназначен' OR
  notes ~* 'Лид переназначен автоматически' OR
  notes ~* 'Статус изменён автоматически' OR
  notes ~* 'Карточка передана автоматически' OR
  notes ~* 'Клиент переведён в Неактивные автоматически' OR
  notes ~* 'Лид назначен утренней волной' OR
  notes ~* '^Лид создан автоматически' OR
  notes ~ '^\[[a-z]+\.[a-zA-Z0-9-]+\]' OR
  notes ~* '^Первый звонок не совершён' OR
  notes ~* '^Лид в общем пуле «ничьих»' OR
  notes ~* 'Заявку не принял никто'
);

-- 2. AI — разбор/подсказка модели (по тексту).
UPDATE "Interaction" SET
  "subjectAgentId" = "agentId",
  "agentId" = NULL,
  "actorKind" = 'AI'
WHERE "actorKind" = 'AGENT' AND "agentId" IS NOT NULL AND (
  notes ~* '^ИИ уточнил карточку' OR
  notes ~* 'Клиент упомянул в разговоре' OR
  notes ~* 'Показ назначен автоматически'
);

-- 3. AI — outcomeSource='AI_AUTO' (структурный признак, не текст).
UPDATE "Interaction" SET
  "subjectAgentId" = "agentId",
  "agentId" = NULL,
  "actorKind" = 'AI'
WHERE "actorKind" = 'AGENT' AND "agentId" IS NOT NULL AND "outcomeSource" = 'AI_AUTO';

-- 4. BOT — бот действовал сам по сценарию (не по прямому слову клиента).
UPDATE "Interaction" SET
  "subjectAgentId" = "agentId",
  "agentId" = NULL,
  "actorKind" = 'BOT'
WHERE "actorKind" = 'AGENT' AND "agentId" IS NOT NULL AND (
  notes ~* 'Показ назначен ботом' OR
  notes ~* '^Бот не смог'
);

-- 5. CLIENT — сам клиент (переписка/отзыв).
UPDATE "Interaction" SET
  "subjectAgentId" = "agentId",
  "agentId" = NULL,
  "actorKind" = 'CLIENT'
WHERE "actorKind" = 'AGENT' AND "agentId" IS NOT NULL AND (
  notes ~* 'Клиент снова написал боту' OR
  notes ~* '^Отзыв после сделки'
);

-- 6. Входящие с директором-фолбэком: IncomingCall.answeredBy не совпал ни с
-- одним активным sipExtension — фолбэк подписал звонок собой (см. разбор
-- incomingCalls.ts до этой правки, recon 04 §b.1).
UPDATE "Interaction" i SET
  "subjectAgentId" = i."agentId",
  "agentId" = NULL,
  "actorKind" = 'SYSTEM'
FROM "IncomingCall" c
WHERE c."interactionId" = i.id
  AND c.answered = true
  AND i."actorKind" = 'AGENT' AND i."agentId" IS NOT NULL
  AND (
    c."answeredBy" IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM "Agent" a
      WHERE a."sipExtension" = c."answeredBy" AND a."isActive" = true
    )
  );

-- 7. СПАМ — УДАЛЕНИЕ (owner Р-8: «спам вычистить и не плодить»). Оставляет
-- ровно одну запись там, где правило требует «одну на X».

-- 7a. «Первый звонок не совершён — лид остаётся у того же агента» сверх
-- первой на клиента (порядок по createdAt).
DELETE FROM "Interaction" i
WHERE notes ~* 'Первый звонок не совершён' AND notes ~* 'остаётся у того же агента'
  AND i.id NOT IN (
    SELECT DISTINCT ON ("clientId") id FROM "Interaction"
    WHERE notes ~* 'Первый звонок не совершён' AND notes ~* 'остаётся у того же агента'
    ORDER BY "clientId", "createdAt" ASC
  );

-- 7b. «Лид в общем пуле «ничьих»» сверх одной на клиента.
DELETE FROM "Interaction" i
WHERE notes LIKE 'Лид в общем пуле «ничьих»%'
  AND i.id NOT IN (
    SELECT DISTINCT ON ("clientId") id FROM "Interaction"
    WHERE notes LIKE 'Лид в общем пуле «ничьих»%'
    ORDER BY "clientId", "createdAt" ASC
  );

-- 7c. `[manual.*]`/`[lost.promote]` сверх одной на клиента и календарный день.
DELETE FROM "Interaction" i
WHERE notes LIKE '[lost.promote]%'
  AND i.id NOT IN (
    SELECT DISTINCT ON ("clientId", DATE("createdAt")) id FROM "Interaction"
    WHERE notes LIKE '[lost.promote]%'
    ORDER BY "clientId", DATE("createdAt"), "createdAt" ASC
  );

-- 7d. Дубли эскалаций на каждого руководителя — оставить одну на клиента,
-- текст и минуту (руководителям уже ушли уведомления отдельно, вторая копия
-- в хронологии клиента — чистый спам).
DELETE FROM "Interaction" i
WHERE notes ~* 'эскалация'
  AND i.id NOT IN (
    SELECT DISTINCT ON ("clientId", notes, DATE_TRUNC('minute', "createdAt")) id FROM "Interaction"
    WHERE notes ~* 'эскалация'
    ORDER BY "clientId", notes, DATE_TRUNC('minute', "createdAt"), "createdAt" ASC
  );

-- 7e. Служебные маркеры noAnswerTail:* — технический след, не запись работы.
DELETE FROM "Interaction" WHERE notes LIKE 'noAnswerTail:%';

-- 8. CHECK — В КОНЦЕ, после того как перекраска/чистка выше сделали данные
-- честными: AGENT обязан иметь agentId, остальные акторы — обязаны его не
-- иметь. Новые записи идут только через lib/timeline.ts (см. страж
-- timeline-single-writer.test.ts), который эту пару уже поддерживает верно —
-- ограничение фиксирует инвариант в БД на случай прямого SQL/скрипта в обход.
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_actor_kind_agent_id_check"
  CHECK (
    ("actorKind" = 'AGENT' AND "agentId" IS NOT NULL) OR
    ("actorKind" <> 'AGENT' AND "agentId" IS NULL)
  );
