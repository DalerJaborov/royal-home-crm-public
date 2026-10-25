# 2026-10-23 — цикл ядра клиентского агента больше не оставляет клиента без ответа

Ветка `fix/core-loop-23-10`. Зона: `apps/api/src/ai/customerAgentCore.ts` плюс узкие хвосты трассы.

## Что менялось и почему

1. **Состоявшаяся запись не кончается молчанием (F08).** Если у хода есть receipt и модель не довела
   дело до ответа — кончились раунды, лимит вызовов/ввода/вывода, невалидный финал, запрещённое для
   поверхности решение (`skip`), ссылки без отрисовки, второй неизвестный инструмент — ядро само строит
   `reply` по receipt-ссылкам и отдаёт его тем же рендерером и тем же delivery fence. Запись не повторяется;
   неподтверждённая запись (`unknown`) и остановленная операция по-прежнему дают HELD. После коррекции
   модель не может повторить запись (`repeated_effect_denied` тоже ведёт к подтверждению).
   Результат помечен `fallbackReason: "receipt_confirmation"` и `fallbackCause` (какой HELD заменён).
2. **Один корректирующий раунд (F09), только для личной переписки.** Невалидный финальный JSON,
   `skip`/модерация в DM и неизвестное имя инструмента возвращают модели структурированную ошибку
   (`serverProtocolError` с кодом и путями полей схемы, без значений); раунд не тратит `toolCalls`.
   Второй провал — HELD, как раньше. Публичные комментарии коррекции не получают (у них правило «без лишнего
   запроса к модели» и запасной вариант по проверенным ссылкам).
3. **Лимит вызовов.** Предварительные чтения сервера (`get_company_information`, `get_open_vacancies`,
   `get_property_facts`) не расходуют 4 вызова модели; отклонённый батч не расходует вызовы (раунд тратит).
   `toolCalls` в результате по-прежнему показывает фактически выполненное.
4. **Промт.** Системный промт один на все поверхности и входит в `promptHash` (смена хэша ломает продвижение
   ревизии — `customerAgentOwnerPolicy`, `customer-recruitment-upgrade`), поэтому набор допустимых решений
   по поверхности передаётся в первом служебном сообщении контекста (`serverSurface.allowedDecisionKinds`) и в
   тексте коррекции. Сам текст промта не менялся, `customerAgentRegistration` не тронут.
5. **Дополнение координатора.** `mixed_model_protocol` убран: текст рядом с вызовами игнорируется, вызовы
   выполняются. `facts_unavailable` в DM после упавшего предчтения — серверный `clarify/property` (текст
   рендерера «Какой объект… Пришлите номер объекта или ссылку»); в публичном комментарии остаётся HELD.
6. **Диагностика.** Общий `catch` теперь сохраняет безопасный код причины (`safeCauseCode`: наши
   snake_case-коды или имя класса ошибки, не текст) в `held.cause`; `turn_deadline` (120 с) — отдельная причина.
   В трассе новое поле `customerCore.causeCode` (shared `traceCustomerCoreSchema`) и значение
   `decisionSource: "receipt_confirmation"`. Адаптеры DM/публичный передают причину своего `catch`
   (`customer_core_unavailable`, `public_core_unavailable`) в `traceCustomerCoreDisposition`.
   `turn_deadline` добавлен в `technicalReasons` публичного завершения, чтобы поведение осталось прежним,
   как у `turn_unavailable`.

## Проверка

- Новые и обновлённые тесты: `tests/customer-agent-core.test.ts` (22 были красными до починки),
  `tests/bot-turn-trace-customer-core.test.ts`, `tests/customer-agent-verified-context.test.ts`
  (недекларированный инструмент теперь получает одну коррекцию, исполнения по-прежнему нет).
- Прогон без базы (`vitest` без `tests/setup.ts`, псевдоним `@royal-home/shared` на исходники): зелёные.
- `npm run build --workspace=apps/api` — см. отчёт.

## Что осталось

- `receipt_requires_reconciliation` (модель выбрала `escalate`/`skip` после записи) не менялся: это сознательное
  решение передачи сотруднику.
- Нужны с базой: `customer-dm-agent-turn-postgres`, `customer-public-agent-postgres`,
  `customer-agent-mutation-session-postgres`, `customer-handover-ack-postgres`.
- Нужна пересборка `packages/shared` (`build:shared`) перед сборкой API/прогоном трассы в основном дереве.
- Расширить enum `heldReason` в трассе под `turn_deadline`/`facts_unavailable` не пришлось: точная причина
  лежит в `causeCode`.
