# Разведка: инструменты Шабнам, права, тупики (17.11.2026)

Только чтение. Дерево: `C:/Users/Daler/.claude/worktrees/shabnam-brain-17-11`, вершина `ca5535a3`
(get_company_stats/get_lead_sources с from/to — не баг, здесь не разбирается).
Метки: **ФАКТ** — видел в коде (путь:строка); **ОЦЕНКА** — вывод без прогона.
Пути ниже — от `apps/api/src/`, если не сказано иное.

## 1. Инструменты

Как устроено (ФАКТ):
- Встроенные (старые) — массив `TOOLS` и `runTool` в `ai/assistant.ts:275`, `:540`; запись среди них —
  `create_task`/`reschedule_task` (`ai/assistant.ts:1121`), исполняются СРАЗУ, без карточки.
- Плагины — реестр `ai/assistant/tools/index.ts:44`; плагин записи (B/C) сам регистрирует исполнитель
  в брокере `lib/assistantActions.ts` (`index.ts:31-36`).
- Запись объявляется модели только при `confirmUi` и если канал есть в `executor.channels`
  (`ai/assistant.ts:1162-1175` → `pluginDeclarations`); в Telegram `confirmUi = !readOnly`
  (`telegram/assistantBot.ts:550`). Без `confirmUi` запись отказывает (`ai/assistant.ts:1427`).
- Права: подсказка — `allowed` плагина и `TOOL_GATES` (`ai/assistant/actor.ts:148-153`);
  защита — `executor.requires`, канал, `privateTelegram` в брокере (`lib/assistantActions.ts:232-241`)
  и проверки внутри `snapshot`/`execute`. Права ВСЕГДА вызвавшего: актор строится из `AgentAccess`
  (`actor.ts:73-94`); на нажатии права перечитываются (`telegram/assistantBot.ts:1937-1950`).
- Step-up (`executor.stepUp`): CRM — окно `lib/stepUp.ts`, Telegram — код Google Authenticator
  (`lib/assistantActions.ts:248-264`).
- Общая группа Telegram: актор без части прав (`GROUP_HIDDEN_PERMISSIONS`) + `GROUP_HIDDEN_TOOLS`
  (`telegram/assistantBot.ts:157-183`, `:194-202`). `privateTelegram` у исполнителя — вторая стена.
- Кнопка «Отменить» в Telegram — только `STAFF_TOOL_NAMES` + `change_client_agent`
  (`telegram/assistantBot.ts:138`). В CRM — у всех, у кого есть undo.

Обозначения: Ур — уровень (A чтение / B запись сразу с откатом / C карточка «Подтвердить»).
Где: C — чат CRM, Л — личка Telegram, Г — общая группа. «Г: да» = объявляется в группе.

| Инструмент | Что делает | Ур | Права (чьи — вызвавшего) | SU | Где |
|---|---|---|---|---|---|
| search_properties | поиск объектов по фильтрам/номеру | A | все | — | C Л Г |
| search_clients | поиск клиентов | A | ownScope без clients.viewAll (`assistant.ts:543`) | — | C Л Г |
| get_company_stats | сводка воронки за период | A | ownScope; комиссия — своя или finance.view | — | C Л |
| get_client_history | история клиента | A | ownScope + accepted | — | C Л Г* |
| search_deals | сделки | A | deals.viewAll иначе свои | — | C Л |
| get_finance_summary | финансы месяца | A | finance.view (`actor.ts:149`) | — | C Л |
| get_lead_sources | лиды по каналам | A | reports.view (`actor.ts:150`) | — | C Л |
| get_upcoming_showings | ближайшие показы | A | ownScope | — | C Л Г |
| web_reference | справка с поиском Google | A | тумблер groundedSearch | — | C Л Г* |
| create_task | задача-напоминание по клиенту | запись сразу | assertClientWritable, не акционер (`actor.ts:151`) | — | C Л |
| reschedule_task | перенос задачи клиента | запись сразу | assertClientWritable + ownScope | — | C Л |
| find_clients / find_property / find_properties_by_place | поиск (вкл. Корзину) | A | ownScope / все | — | C Л Г |
| find_open_tasks | открытые задачи | A | privateWriteAllowed (`privateWriteAllowed.ts:4`) | — | C Л |
| get_client_card / get_property_card / get_property_work_status / list_my_tasks | карточки, ход работ, мои задачи | A | ownScope / все | — | C Л Г* |
| get_client_last_call | расшифровка последнего звонка | A | allowsPrivateTranscript | — | C Л |
| search_company_knowledge | общие знания | A | активный | — | C Л Г |
| get_deal_card / get_my_commission | сделка, моя комиссия | A | dealToolsAllowed (личные режимы) | — | C Л |
| get_payouts_due | к выплате | A | + finance.view | — | C Л |
| market_for_client / market_property_price | рынок под клиента / цена против рынка | A | все | — | C Л / C Л Г |
| list_expenses … get_expense_history (8 шт.) | расходы: список, сводка, прогноз, свод, подписки, архив, статьи, история | A | finance.view | — | C Л |
| list_staff / get_staff_card / staff_now | сотрудники | A | agents.manage / team.viewFull / permissions.manage, только личные | — | C Л |
| change_client_agent | сменить агента клиента | C | clients.assign (`changeClientAgentTool.ts:141`) | — | C Л |
| create_client | новый клиент | C | privateWriteAllowed; транзакция | — | C Л |
| delete_client | свой клиент в Корзину | C | только закреплённый за собой (`deleteClientTool.ts:56`) | — | C Л |
| change_property_price | цена: свой — сразу, чужой — заявка PRICE_CHANGE | C | properties.requestChange (`changePropertyPrice.ts:75`, `changeRequestTool.ts:169`) | — | C Л Г |
| change_property_status | статус → **заявка OTHER, ничего не меняет** | C | properties.requestChange (`changePropertyStatus.ts:131`) | — | C Л Г |
| request_property_change | данные карточки (свой — сразу), UNPUBLISH, OTHER | C | properties.requestChange (`requestPropertyChange.ts:133`) | — | C Л Г |
| send_to_remake | ролик на перемонтаж (необратимо) | C | sendBackDenied (`sendToRemake.ts:111`) | — | C Л Г |
| delete_property | объект в Корзину | C | свой (assigned/intake) или properties.delete (`deletePropertyTool.ts:46-49`) | — | C Л Г |
| restore_property | из Корзины | C | canRestorePropertyAs | — | C Л Г |
| book_showing / reschedule_showing / cancel_showing | показы | C | assertClientWritable / showingAccess | — | C Л Г |
| add_client_note | заметка в карточку | B | assertClientWritable (`addClientNoteTool.ts:59`) | — | C Л |
| complete_task | закрыть задачу | C | foreignTaskWriteDeniedFor; транзакция | — | C Л |
| add_expenses + update/delete/restore/pay/undo_expense_payment, *_recurring_expense, recurring_expense_payment, create/update_expense_category (13 шт.) | расходы | C | finance.view + finance.manage (`expenseWriteTools.ts:58`, `expenseBatchTool.ts:400`) | — | C Л |
| create_deal / change_deal_stage / close_deal | сделки | C | privateWriteAllowed + проверки сделки; агент закрывает «на одобрение» (`dealWriteTools.ts:397`) | — | C Л |
| fix_deal_commission / annul_deal / mark_deal_payout | комиссия / аннулировать / выплата | C | deals.setCommission / deals.complete / canMarkPayout | — | C Л |
| create/update/delete/freeze/unfreeze_staff, handover_staff_work, revert_staff_handover | сотрудники | C | agents.manage (`staffWriteTools.ts:260…`) | да | C Л |
| reset_staff_2fa / set_staff_permissions | 2FA / права | C | agents.reset2fa / permissions.manage | да | C Л |
| pause_staff_leads / resume_staff_leads | пауза заявок | C | agents.manage | нет | C Л |
| transfer_property | передать объект агенту | C | editForeign + clients.assign (`transferPropertyTool.ts:69`, `:127`) | — | C Л |
| set_notification_pref | выключить/включить вид уведомлений | C | своё (`notificationPrefTool.ts:45-48`) | — | C Л |
| save_company_knowledge / archive_company_knowledge | общее знание для всех | C | **любой не-акционер** (`knowledgeTools.ts:64`, `:68`) | — | C Л Г |
| index_company_knowledge | переиндексация знаний | C | crm-private + роль-оператор + флаг (`knowledgeSemanticTools.ts:49`) | — | C |

`Г*` — в группе закрыт в режимах «только чтение»/пересланное (`telegram/assistantBot.ts:456-458`).
Сверка имён: все имена инструментов, упомянутые в промпте и описаниях, есть в реестре, и наоборот (ФАКТ, сверка grep по
`ai/assistant.ts`, `promptSections.ts`, `tools/*.ts`, `telegram/assistantBot.ts`).

## 2. Права по ролям и где Шабнам слабее интерфейса

Роли: DIRECTOR, ADMIN, MANAGER, AGENT, MARKETING, EDITOR, SECURITY, SHAREHOLDER, HEAD_OF_SALES
(`packages/shared/src/enums.ts:9`). Решает не роль, а набор прав `ROLE_PRESETS` + переопределения
(`packages/shared/src/permissions.ts:502-754`). Роль напрямую читают: SHAREHOLDER = только чтение
(`isReadOnlyRole`), MARKETING/EDITOR — запрет цены в REST (`routes/properties/crud.ts:960-966`),
HEAD_OF_SALES — передача объекта (`lib/propertyManualTransfer.ts:43`). Монтажёр = EDITOR.
Через Шабнам роль ничего не расширяет: актор = права сотрудника.

Места, где у Шабнам прав МЕНЬШЕ, чем в CRM (все ФАКТ):
1. **Статус объекта.** CRM: хозяин объекта / editForeign меняет статус опубликованного сам
   (`routes/properties/crud.ts:916`, `:925` canManageProperty; статус открыт после публикации —
   `packages/shared/src/propertyEditLock.ts:49`; проверки `crud.ts:1026-1075`). Шабнам: только заявка OTHER
   (`ai/assistant/tools/changePropertyStatus.ts:43`, `:84`), которую никто не исполняет (см. §3 Т1).
   Этапы конвейера (проверка/фото/видео/монтаж) Шабнам не двигает вовсе (`changePropertyStatus.ts:59-65`),
   хотя MARKETING с properties.moderate двигает их в CRM (`crud.ts:1048-1053`).
2. **MANAGER, MARKETING, EDITOR без `properties.requestChange`** (`permissions.ts:523-563`, `:593`, `:648`)
   → у них скрыты и отказывают цена, статус, данные карточки (`changePropertyPrice.ts:75`,
   `changePropertyStatus.ts:131`, `requestPropertyChange.ts:133`, `changeRequestTool.ts:169`), хотя в CRM с
   `properties.editForeign` они правят любую карточку PATCH-ем. (Запрет цены для MARKETING/EDITOR из
   `crud.ts:960-966` при починке сохранить.)
3. **Неопубликованная карточка.** Сервис заявок отказывает «До публикации карточку можно править самому»
   (`lib/propertyChangeRequestService.ts:89-90`), а другого инструмента правки нет: агент не может через
   Шабнам поправить цену/этаж/адрес объекта на этапе подготовки; в CRM — может.
4. **Удаление клиента.** CRM: `clients.delete` удаляет любого (`routes/clients/card.ts:771`), агент — заявкой
   (`routes/clients/deleteRequests.ts`). Шабнам: только закреплённого за собой (`deleteClientTool.ts:56`) —
   директор/РОП не может удалить чужого; нет `restore_client` (CRM: `card.ts:799`) и нет «попросить удалить».
5. **Передача объекта РОПом.** CRM: HEAD_OF_SALES с `transfers.request` + `clients.assign`
   (`lib/propertyManualTransfer.ts:43`). Шабнам требует `properties.editForeign` (`transferPropertyTool.ts:69`,
   `:127`) — у РОПа его нет, инструмент скрыт.
6. **Решения по заявкам.** Нет инструментов «одобрить/отклонить» заявку на изменение
   (`routes/properties/changeRequests.ts:77`, `:96`), на удаление объекта/клиента
   (`routes/properties/deleteRequests.ts:165…`, `routes/clients/deleteRequests.ts:182…`). Директор из Telegram
   видит заявку, но решить её может только в CRM.
7. **Модерация фото/видео.** Флаг `canModerate` в акторе есть (`actor.ts:52`), инструмента одобрения
   материалов нет (ОЦЕНКА по реестру — не найден ни один плагин с этим действием).
8. **Своё = не по общему правилу.** `delete_property` считает своим только assigned/intake
   (`deletePropertyTool.ts:46`), а общее правило — ещё и создатель (`lib/propertyAccess.ts:25`).
9. **«Отменить» в Telegram.** Превью цены обещает «кнопка «Отменить» вернёт прежнюю цену»
   (`changeRequestTool.ts:199`), но в Telegram кнопка только у сотрудников и смены агента
   (`telegram/assistantBot.ts:138`). То же у add_client_note (уровень B, «Сделано · Отменить» — только CRM).

Где Шабнам ШИРЕ интерфейса (не баг, решение владельца 03.11 — проверить, что так и задумано):
`delete_property` своего объекта без `properties.delete` (`deletePropertyTool.ts:47`), тогда как REST требует
`properties.delete` (`crud.ts:1784`) и агенту даёт только заявку на удаление.

## 3. Тупики: «сделано», а ничего не произошло

**Т1. Смена статуса (живой баг).** Просьба «верни ОБ-88 в продажу» → `change_property_status` готовит
заявку `OTHER` с текстом (`changePropertyStatus.ts:79-84`) → «Подтвердить» → заявка уходит руководителю →
«Принять» в CRM ставит APPROVED и пишет «Принято к сведению — директор сделает сам»
(`routes/properties/changeRequestExecutor.ts:327-328`, `:338`), автору уходит «одобрено» (`:375`).
Статус не меняется. Обрыв: `changeRequestExecutor.ts:327`. Побочно: пока ждёт «статус», любая другая заявка
«Другое» по объекту блокируется (`changeRequestTool.ts:110-118`).
Починка: вынести ветку статуса из PATCH (`crud.ts:1026-1075` + эффекты снятия `:1356`, `:1531`) в одну дверь
`lib/propertyStatusChange.ts`; инструмент для `canManagePropertyAs` зовёт её сразу (как цена, `directKinds`),
для остальных — новый вид заявки `STATUS_CHANGE`, исполнитель которого зовёт ту же дверь. Для WITHDRAWN —
аргумент `removalReason` (`packages/shared/src/propertyRemoval.ts:5`). Размер L.

**Т2. Прямое применение «не выполнилось», а ответ «применено».** `approvePropertyChangeRequest` при ошибке
исполнения ставит FAILED, но возвращает `ok: true` с `message: "Не выполнилось: …"`
(`changeRequestExecutor.ts:338`, `:387-396`); `applyOwnChangeRequestNow` видит `ok` и не откатывает
(`:639-648`); инструмент пишет `status: "APPLIED", applied: true` (`changeRequestTool.ts:230-241`); Telegram
показывает «Готово» и «цена теперь X» (`telegram/assistantBot.ts:1917` renderGroupPriceResult, `:1887`). Касается цены и данных
карточки своего объекта. Починка: в `applyOwnChangeRequestNow` считать неуспехом `request.status !== "APPROVED"`
(и отдавать `error`), тест на FAILED. Размер S.

**Т3. Заявка «Другое» (request_property_change kind=OTHER).** Честно названа заявкой, но «Принять» = no-op с
итогом APPROVED (`changeRequestExecutor.ts:327`): автор видит «одобрено» и считает сделанным. Починка: у OTHER
статус «Принято, сделать руками» + напоминание директору, или отметка «сделано» вторым нажатием. Размер S.

**Т4. reschedule_task переносит не ту задачу.** Описание: «ближайшую предстоящую» (`assistant.ts:380`),
код берёт `orderBy: nextActionDate desc` — самую дальнюю (`assistant.ts:852`). Запись без карточки, без
отката и без AuditLog (`assistant.ts:860`; журналится только обращение к ИИ). Починка: `asc` + `>= сейчас`,
а лучше перевести в плагин уровня C с превью «было → станет». Размер S (минимум) / M (плагин).

**Т5. Обещанная кнопка «Отменить» отсутствует в Telegram** (см. §2 п.9). Починка: добавить цену/данные в
`UNDO_IN_TELEGRAM` или подставлять текст риска по каналу. Размер S.

**Т6. Действие сделано, а запись о нём «упала».** Нетранзакционный путь: `execute` прошёл, `saveExecutedAction`
упал (`lib/assistantActions.ts:536-555`) → строка висит CONFIRMED → через 15 мин сборщик ставит FAILED
(`jobs/assistantActionsSweep.ts:24`). Человек видел ошибку, действие исполнено, повтор может задвоить.
ОЦЕНКА: редко. Починка: перевести пишущие исполнители на `transactional`, где они только БД. Размер M.

**Т7. Ошибки «после коммита» не видны.** `afterCommit` (уведомления, публикации) падает в `console.error`
(`lib/assistantActions.ts:481-482`, `:673-675`), не в «Здоровье системы». Размер S.

Проверено и тупиком НЕ является (ФАКТ): change_property_price чужого (PRICE_CHANGE исполняется при одобрении),
UNPUBLISH (`changeRequestExecutor.ts:318-325`), send_to_remake (реальная отправка, `sendToRemake.ts:151`),
close_deal агентом (PENDING_APPROVAL — штатное одобрение сделки), set_notification_pref (`lib/notificationPrefs.ts`).

## 4. Прочие баги и хрупкие места

- **Общая группа видит больше, чем, вероятно, задумано** (ОЦЕНКА политики, ФАКТ кода): не скрыты и не
  `privateTelegram` — book/reschedule/cancel_showing (имя клиента и время в превью), change_property_*,
  request_property_change, send_to_remake, delete_property, restore_property, save/archive_company_knowledge
  (`telegram/assistantBot.ts:157-183` против `allowed`/`privateTelegram` в файлах инструментов). Подтвердить
  может только автор (`assistantBot.ts:1756`). Нужно решение владельца по списку.
- **Общие знания пишет любой.** save/archive_company_knowledge — любой не-акционер, в том числе из группы
  (`knowledgeTools.ts:64`, `:68`); знания подмешиваются в ответы всем (`assistant.ts:1600-1605`). Агент может
  переписать или убрать правило директора. Починка: отдельное право. Размер S.
- **Двойное нажатие** — закрыто: условный захват `updateMany` (`lib/assistantActions.ts:407-412`),
  `claimCallback` + `serializeBundle` в Telegram (`assistantBot.ts:1735`, `:1856`). ФАКТ.
- **AuditLog**: все плагины пишут `ASSISTANT_<TOOL>` через брокер (`lib/assistantActions.ts:453-462`,
  `:556-562`); встроенные create_task/reschedule_task — нет (только хронология у create_task). ФАКТ.
- **Проглоченные ошибки**: `cancelPending`/`discardPending…catch(() => undefined)` (`assistantBot.ts:588`,
  `:1802`, `:1967`) — карточки могут остаться PENDING до сборщика; терпимо. Сбой показа карточки модели не
  виден (`tools/run.ts:365-371`) — намеренно.
- **Канал**: `runAuditedTool` не проверяет `executor.channels` сам (`assistant.ts:1415-1431`), но брокер
  отказывает `CHANNEL_NOT_ALLOWED` (`lib/assistantActions.ts:233-236`) — защита есть.
- **Таймауты внешних вызовов** внутри исполнителей (снятие постов при перемонтаже, SEO через ИИ при цене —
  `changeRequestExecutor.ts:125`) — НЕТ ДАННЫХ, не проверял lib-уровень.
- **reschedule_task**: `update` без условия на прежнюю дату — гонка с правкой в CRM (`assistant.ts:860`). Мелочь.

## 5. Как добавить инструмент (рецепт исполнителю)

Образец самого чистого: `ai/assistant/tools/notificationPrefTool.ts` (C, один файл, превью, undo);
для объекта с заявкой — `changePropertyPrice.ts` поверх `changeRequestTool.ts`.
1. Файл `ai/assistant/tools/<имя>Tool.ts`: zod-схема аргументов; исполнитель `{ tool, channels,
   privateTelegram?, requires?, stepUp?, transactional?, parseArgs, snapshot, buildPreview, execute, undo? }`.
   `snapshot`/`buildPreview` ничего не пишут; права проверять в `snapshot` И в `execute` той же функцией
   `lib/*`, что зовёт REST (новых правил не придумывать).
2. `execute` зовёт ту же дверь, что REST, и возвращает `{ result, audit: { entityType, entityId } }`;
   результат честный (проверить итог, а не только `ok`).
3. Плагин: `name === executor.tool`, `level`, `description` (когда звать, что вернётся, «статус сам не меняется» и т.п.),
   `parameters` с непустыми `properties` (пустой объект Gemini роняет весь запрос), `statusPhrase`, `allowed`.
4. Регистрация — в группу (`readTools.ts`, `propertyTools.ts`, `showingNoteTools.ts`, `clientOwnershipTools.ts`,
   `expenseTools.ts`, `staff*Tools.ts`) или прямо в список `tools/index.ts:44`.
5. Группа Telegram: добавить в `GROUP_HIDDEN_TOOLS` (`telegram/assistantBot.ts:157`) или `privateTelegram: true`;
   сотрудники — в `STAFF_TOOL_NAMES` (`tools/staffToolNames.ts`); расходы — буквами в тот же список (сверка
   `tests/assistant-expense-batch.test.ts`). Откат в Telegram — `UNDO_IN_TELEGRAM` (`assistantBot.ts:138`).
6. Сторожа: имя — в список `tests/ai-assistant-tool-registry.test.ts:54`; общие проверки реестра (схема,
   уникальность, исполнитель) там же идут сами; по группам — `assistant-staff-rights.test.ts`,
   `assistant-group-callback-gate.unit.test.ts`.
7. Свой тест (образец `tests/ai-assistant-property-tools.test.ts`): превью → подтверждение исполняет один раз,
   отказ по правам, STALE при изменении между превью и нажатием, откат.
8. Промпт не трогать без нужды; правка `SYSTEM_PROMPT` — поднять `SYSTEM_PROMPT_VERSION` (`ai/assistant.ts:205`).
9. `npm run map`, `npm run map:check`, `npm run precheck`, запись в `docs/journal/`.

## Топ-10 починок

| # | Что | Размер |
|---|---|---|
| 1 | Т1: статус объекта — одна дверь `lib/propertyStatusChange.ts` из PATCH; свой — сразу, чужой — заявка STATUS_CHANGE с исполнителем | L |
| 2 | Т2: прямое применение FAILED выдаётся за «применено» — проверять `request.status` | S |
| 3 | §2 п.2: MANAGER/MARKETING/EDITOR — открыть правку объектов по `canManagePropertyAs`/editForeign вместо requestChange, сохранить запрет цены маркетингу | M |
| 4 | §2 п.3: правка неопубликованной карточки через ту же дверь PATCH (вместе с №1) | M |
| 5 | §2 п.6: инструменты «одобрить/отклонить» заявки на изменение и удаление для руководства | M |
| 6 | Т3: «Другое» при одобрении — не APPROVED-no-op, а «сделать руками» с напоминанием | S |
| 7 | §2 п.5: transfer_property для РОПа через `canTransferProperty` в allowed и requires | S |
| 8 | §2 п.4: delete_client для `clients.delete` + restore_client + заявка на удаление для агента | M |
| 9 | §4: право на запись общих знаний; решение владельца по списку инструментов в группе | S |
| 10 | Т4/Т5: reschedule_task (ближайшая задача, карточка, аудит) и обещанное «Отменить» в Telegram | S |
