# 17.11.2026 — Шабнам: «режим директора» (заявки, ошибки, здоровье, рубильники)

- Что изменилось: новый файл `apps/api/src/ai/assistant/tools/directorTools.ts`, семь инструментов:
  `list_pending_requests` (заявки на изменение и удаление объектов и клиентов, объекты на проверке
  фото/видео), `decide_request` (одобрить/отклонить заявку, карточка «Подтвердить»), `get_error_log`
  и `resolve_error` (журнал ошибок, «разобрано» с откатом), `get_system_health` (база, фоновый
  обработчик, каналы, «что не доехало», бэкапы, падающие фоновые задачи), `list_switches` и
  `set_switch` (рубильники Настроек из белого списка, только с кодом Google Authenticator / подтверждением
  личности в CRM). Тела «отклонить заявку на изменение» и «одобрить/отклонить заявку на удаление»
  (объекта и клиента) вынесены из маршрутов в `lib/managerRequestDecisions.ts`, «разобрано / вернуть в
  работу» — в `lib/errorLogActions.ts`; маршруты переведены на вынесенное без смены ответов. Белый список
  рубильников и запись — `lib/settingsSwitches.ts` (те же кирпичи, что PATCH /settings: точка возврата,
  saveWithInvestigationControlAudit, побочные эффекты, журнал SETTINGS_UPDATE). В общей группе Telegram
  все семь скрыты (`GROUP_HIDDEN_TOOLS`), не объявляются и не пускаются брокером (privateTelegram).
- Почему: владелец 17.11 — «дай любые права боту… чтобы он был как супер мозг и руки компании, даже на
  бекенде работал». Решение сборщика: сырого SQL, командной строки и произвольных настроек не даём
  (помощница читает чужой текст — одна подмена снесла бы базу); вместо этого — управляющие инструменты
  поверх тех же функций, что экран CRM, с правами маршрута-источника.
- Чем проверено: только чтением кода (сверка импортов, сигнатур и типов по схеме Prisma).
  Сборка и тесты НЕ запускались (на ПК 1,5 ГБ свободной памяти, `node_modules` нет). Сборщику прогнать:
  `npm run build:api`, `cd apps/api && npx vitest run tests/ai-assistant-director-tools.test.ts
  tests/ai-assistant-tool-registry.test.ts tests/property-delete-request.test.ts
  tests/rop-decides-delete-requests.test.ts tests/audit2-a2-delete-request-decision-race.test.ts
  tests/property-change-requests.test.ts tests/assistant-expense-batch.test.ts
  tests/assistant-group-callback-gate.unit.test.ts`, затем `npm run map` (тела маршрутов изменились —
  карта развилок пересоберётся) и `npm run precheck`.
- Что осталось: решения по модерации фото/видео через Шабнам (сейчас только список); кнопка «Отменить»
  в Telegram для `set_switch`/`resolve_error` (откат есть в CRM, в `UNDO_IN_TELEGRAM` не добавлено);
  PATCH /settings целиком не переведён на общую функцию — переиспользованы его кирпичи.
