# 2026-10-23 — щит исходящих и контекст ядра глушили живых людей (F02, F03, F12)

## Что изменилось
- **F03 (щит).** Настоящее входящее от человека (подпись Meta, любая assurance) снимает паузу, которую поставил САМ щит
  (`repeat/monologue/rate_*`), в транзакции приёма (`customerIngressRecovery`, `noteRealInboundInTx`) ДО фиксации «забора»
  диалога: позже снятие меняет `ownershipEpoch` и ход ядра падает в `original_context_changed`, а пока пауза стоит —
  принципал отказывает `scope_blocked` на 6 часов. Ручная пауза сотрудника (не совпал `pauseFence`) не снимается.
  `lastInboundAt` только вперёд (`classifyInbound`: повтор mid и старое время — no-op, счётчик монолога не обнуляется).
  Ядро после приёма вызывает `noteRealInbound(preserveNativeOwner)` для ЛЮБОЙ assurance (раньше только protected → у
  public_envelope возраст не ставился никогда). Ответ ядра на конкретное входящее (строка очереди с `ticketEventKey`,
  `BOT_TURN`/`HANDOVER_ACK`) идёт с `answersInbound` и считается ответом вне 10-минутного окна. Ошибки записи входящего
  — в `logSystemError`, не только в console.
- **F02.** `verifyAndRegisterMetaCustomerIssuer`: без своего секрета у аккаунта и с двумя глобальными секретами строгое
  доказательство принимается, если подпись подошла ровно одному; верификатор привязывается к подошедшему секрету (тот же
  `verifierCredential`, что и при одном ключе). Старые public_envelope задним числом не повышаются. Фикстура
  `customerCoreGoldenFixture({publicEnvelope})` теперь даёт аккаунту СВОЙ секрет (иначе она перестала бы быть публичной).
- **F12.** `hasNewerCustomerInboxInput` не считает «новее» вход, закончившийся без ответа (HELD с другим кодом, FAILED).
  Закончился так — `consumeCustomerInboxTicket` перезапускает потребителя последнего отложенного (`newer_input_pending`)
  входа (`resumeDeferredCustomerInbox`; барьер — любой PLANNED позже). Ход собирает текст отложенных входов (до 5, 10 мин,
  ≤2000 зн., хронологически, минимизация как у памяти, вложения — маркером, транскрипт — только protected+protected) в
  текущий ввод (`loadDeferredCustomerInput`).

## Чем проверено
- `npm run build --workspace=apps/api` — код 0.
- Чистые тесты (vitest без БД): customer-issuer-two-global-secrets (красный до правки, 6/6 после),
  outbound-shield-inbound-rules, customer-newer-inbox-input, customer-shield-pause, customer-principal-tools — 102/102.

## Нужна база (не прогонялось)
- `tests/outbound-shield.test.ts` (новый блок F03; прежние тесты щита), `customer-public-envelope-*-postgres`,
  `customer-dm-agent-turn-postgres`, `customer-ingress-recovery-postgres`, `customer-actions-postgres` (фикстура).
- Не покрыто тестом: SQL `resumeDeferredCustomerInbox` и `loadDeferredCustomerInput` (нужны настоящие билеты) — проверить
  на стенде: A отложен из-за B, B закончился HELD → A отвечен; A+B → один ответ с вопросом A.

## Осталось / риски
- В protected-режиме отложенный текст уже есть в истории (`turns`) — теперь он и в текущем вводе (дубль безвредный).
- Возобновлённый ход проходит все обычные проверки (дедлайн 15 мин, fence, newer); при провале снова HELD.
