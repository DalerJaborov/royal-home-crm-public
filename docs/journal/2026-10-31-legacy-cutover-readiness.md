# 31.10.2026 — перевод клиентов LEGACY на ядро: допуск готов, смена полосы упёрлась в миграцию

Решение владельца 31.10: «переводи старых клиентов на ядро». Пачка P10.

## Что выяснено (разведка)

- Полоса живёт в `CustomerAgentRolloutAssignment`: одна строка на субъекта
  (unique `surface+endpointScopeId+subjectKey`) и **неизменяемая** — триггер
  `customer_rollout_assignment_immutable` (миграция `20261015012000`) отвергает любой UPDATE.
  Вторую строку на того же субъекта не вставить из-за unique. Оба факта закреплены тестом.
- Билеты ядра обязаны ссылаться на назначение с `lane='CORE'`: триггер
  `customer_rollout_ticket_source` (LEGACY-назначение запрещает `intakeAgentRevisionId`),
  приём контакта и мост новой заявки (`customerActionJournal.ts` ~:361,
  `customerNewLeadBridge.ts` ~:158) ищут `a."lane"='CORE'`. Перевод «в обход» назначения
  (билет без `rolloutAssignmentId`) потерял бы создание лида — неприемлемо.
- Где читается полоса: `customerAgentEnrollment.ts` (`assignment()`, `fromAssignment`,
  `readCustomerDmSubjectExecution`, `readCustomerDmSourceExecution`), `customerAgentIngressRouting.ts`
  (единственная транзакция выбора полосы для нового входящего), `customerIngressProducer.ts`,
  `customerIngressRecovery.ts`, `customerQualifierContext.ts:37`, `messengers/conversation.ts:1988`,
  `routes/webhooks.ts` ~:1701 и ~:2026, `customerPropertyAdmission.ts:70`, `customerAgentRevisionAdvance.ts`
  (родословная по назначению), `customerAgentOwnerPolicy.ts` (счётчики).
- Ручной режим: `BotConversation.pausedUntil` (оператор/сдача повтора), `propertyChatAgentId`,
  `spamFlaggedAt`, `CustomerInquiry.ownerMode='HUMAN'`, `closedAt`.
- Незавершённая работа: `pendingSince`/`pendingMessages`/`pendingAttachments` (дебаунс),
  `BackgroundJob` PENDING/RUNNING с `payload.conversationId` (`ai-reply-retry` и др.),
  `CustomerOutboxPart` READY/IN_FLIGHT, билеты RECEIVED/CLAIMED.
- История для ядра: `customerAgentVerifiedContext` строит окно только из билетов с
  зашифрованным исходным FINAL и принятых частей ядра той же ревизии. Перенос реплик
  `BotConversation.messages` (там же ответы старого движка и сотрудников) ломает эту
  модель доверия — слишком широко, к тому же файл в зоне P3. Перевод — без истории.

## Что сделано

- `apps/api/src/lib/customerAgentLegacyCutover.ts`: `readCustomerLegacyCutoverReadiness`
  (только чтение, в транзакции вызывающего; причины отказа перечислены),
  `customerAgentLegacyCutoverEnabled` (переменная `CUSTOMER_AGENT_LEGACY_CUTOVER=on`,
  по умолчанию выключено), константа причины `legacy_cutover_owner_31_10`.
  В маршрутизацию НЕ подключено — без миграции нечего записывать.
- Тест `apps/api/tests/customer-agent-legacy-cutover-postgres.test.ts` (6 тестов).

## Нужная миграция (решение владельца/ревью Opus)

Append-only «поколение» назначения вместо перезаписи:

1. `CustomerAgentRolloutAssignment`: колонки `generation INT NOT NULL DEFAULT 0`,
   `supersedesAssignmentId TEXT NULL UNIQUE REFERENCES` (self, RESTRICT),
   `transitionReason TEXT NULL`; CHECK: `generation=0` ⇔ `supersedes IS NULL AND reason IS NULL`;
   при `generation>0` — `lane='CORE'` и `reason='legacy_cutover_owner_31_10'`.
2. Unique `(surface,endpointScopeId,subjectKey)` → `(surface,endpointScopeId,subjectKey,generation)`.
3. Триггер вставки: для `generation>0` — предыдущая строка того же субъекта с
   `generation-1` и `lane='LEGACY'`, политика scoped/ACTIVE, субъект в `allowed`,
   когорта/кандидат = текущий конфиг (как у первичной CORE-вставки).
4. Код: `assignment()` берёт строку с наибольшим `generation` (сейчас бросает на >1 строки);
   старые LEGACY-билеты продолжают ссылаться на строку поколения 0 и читаются как раньше
   (повторная доставка старого сообщения не попадёт в ядро и не даст второго ответа).
5. Подключение: в `customerAgentIngressRouting.ts` только для `!source && eventKey`
   (новое входящее, не повтор), при `customerAgentLegacyCutoverEnabled()` и
   `readCustomerLegacyCutoverReadiness().ready` — вставка поколения 1 в той же транзакции,
   плюс запись аудита `CUSTOMER_AGENT_LANE_CUTOVER` (old→new, причина) там же, через `tx`.

Откат: выключить переменную — новые переводы прекращаются; уже переведённые остаются
CORE (строка неизменяема, как и у остальных CORE-субъектов).

## Чем проверено

- `npx vitest run tests/customer-agent-legacy-cutover-postgres.test.ts tests/customer-agent-enrollment-postgres.test.ts` — 16/16.
- `npm run build --workspace=apps/api` — код 0.
