# Шабнам как «мозг компании»: разрыв CRM и инструментов (разведка 17.11.2026)

Метки: ФАКТ (видел в коде копии `shabnam-brain-17-11`, HEAD ca5535a3) / ОЦЕНКА. «Двери нет» = готовой функции в `lib/*` нет, логика сидит внутри обработчика маршрута.
Правка не делалась. Предыдущие документы: `shabnam-full-gap-list-2026-11-10.md` (592 действия, ЕСТЬ 28), `shabnam-everything-plan-2026-11-10.md`, `shabnam-parity-plan-2026-11-07.md`.

## 0. Что изменилось с 10.11 (сверка со старым списком)

Было НЕТ, теперь ЕСТЬ (ФАКТ, реестр `ai/assistant/tools/index.ts`):
- Сотрудники и права, всё директору с кодом Authenticator: `staffWriteTools.ts` (create/update/delete/freeze/unfreeze_staff, handover_staff_work, revert_staff_handover, reset_staff_2fa, set_staff_permissions, pause/resume_staff_leads), чтение `staffReadTools.ts` (list_staff, get_staff_card, staff_now), `transferPropertyTool.ts`. Было «П7/пачка 5» в плане.
- Расходы целиком (19 инструментов): `expenseReadTools.ts`, `expenseWriteTools.ts`, `expenseBatchTool.ts` (add_expenses). В плане было «ЧАСТИЧНО».
- Сделки: чтение `dealReadTools.ts` (get_deal_card, get_my_commission, get_payouts_due), запись `dealWriteTools.ts` (create_deal, change_deal_stage, close_deal, fix_deal_commission, annul_deal, mark_deal_payout). Было «только чтение».
- Объект: правка данных карточки СВОЕГО объекта сразу, чужого заявкой (`request_property_change`, kind CARD_DATA, `directKinds`, правило `lib/propertyAccess.ts::canApplyChangeDirectly`). Было «ЧАСТИЧНО, П5». Список разрешённых полей = `propertyUpdateSchema.pick(...)` на сервере (проверить, что покрывает этаж, площадь, описание, адрес; ОЦЕНКА).
- Рынок: `marketTools.ts` (market_for_client, market_property_price); знания: `knowledgeTools.ts`, `knowledgeSemanticTools.ts`; тумблер уведомлений `notificationPrefTool.ts`; корзина объектов restore/delete; `create_client`, `delete_client`; `get_client_last_call`; `find_properties_by_place`; `send_to_remake`.
- Строго в этой ветке: ca5535a3 — сводка обращений за день и отрезок дат у `get_company_stats`/`get_lead_sources` (закрыто, не предлагаю).
- Статусы клиентов/«Отложенные»/светофор убраны 16–17.11 (память, PR #220/#222; в коде `deferClient` осталась только в комментарии `lib/clientRefuse.ts:124`). Раздел «статус/этап клиента» из старого плана П4 снят, ОЦЕНКА.

Осталось НЕТ из старого плана (ФАКТ, инструментов нет): П4 правка полей клиента, отказ, вернуть клиента из Корзины; П6 чаты и звонки (лента, пропущенные); П7 контроль руководителя, пульт, ошибки, реклама, вакансии; П8 «Шабнам пишет первой»; фото/видео к существующему объекту; очередь монтажа/ролики в соцсети (кроме `get_property_work_status`).

## 1. Таблица: область, руками, инструмент, чего не хватает

| Область | Руками в CRM | Инструмент Шабнам | Не хватает (дверь) |
|---|---|---|---|
| Клиенты: найти/открыть | список, карточка | find_clients, search_clients, get_client_card, get_client_history | подбор «похожих», «кому не звонили» (нет) |
| Клиент: создать | форма | create_client | есть |
| Клиент: правка полей (имя, бюджет, район, комнаты) | `PATCH /clients/:id` `routes/clients/card.ts:1136` | нет | двери нет: логика внутри маршрута (маски номера, `foreignWriteDenied`, `clientUpdateSchema`); нужен вынос в `lib/` (L) |
| Клиент: заметка | таймлайн | add_client_note | есть |
| Клиент: передать агенту | кнопка | change_client_agent (`clients.assign`) | есть |
| Клиент: принять/отклонить лид | «Принять» | нет | дверь есть: `lib/leadAccept.ts::acceptLead`, `leads.ts::declineLead` |
| Клиент: отказ | кнопка `/:id/refuse` | нет | дверь есть: `lib/clientRefuse.ts::refuseClient` (+ `checkRefusalPreconditions`) |
| Клиент: в Корзину | удалить | delete_client | есть |
| Клиент: вернуть из Корзины | `POST /:id/restore` `card.ts:799` | нет (только чтение Корзины) | дверь есть: `lib/restoreClient.ts::restoreClientFromTrash` (S) |
| Клиент: дубли/слияние | экран дублей | нет | двери есть: `lib/duplicateClients.ts::findDuplicateClientGroups`, `lib/clientMerge.ts::mergeClients` (право `clients.merge`) |
| Задачи | календарь | list_my_tasks, find_open_tasks, complete_task, create_task, reschedule_task | create/reschedule встроены в `assistant.ts:749,776`, не плагины (B-запись без карточки); «закрыть пачкой» нет |
| Показы | календарь | book/reschedule/cancel_showing, get_upcoming_showings, итог показа | есть |
| Сделки/комиссия | `/deals` | 3 чтения + 6 записей (см. п.0) | документы сделки (`dealDocuments.ts`) нет |
| Объекты: найти/карточка/статус рабочий | список | find_property, find_properties_by_place, search_properties, get_property_card, get_property_work_status | есть |
| Объект: создать | мастер | черновик в Telegram `telegram/assistantPropertyDraft.ts` | в CRM-чате нет (ОЦЕНКА) |
| Объект: цена/статус | кнопки | change_property_price, change_property_status | есть |
| Объект: правка любого поля | форма `PATCH /properties/:id` `routes/properties/crud.ts:916` | request_property_change CARD_DATA | неопубликованный объект: идёт ли тем же путём, не проверено (НЕТ ДАННЫХ); замок публикации `propertyEditLocked`, цена проданного/резерва только руководство (crud.ts ~960-990) |
| Объект: фото | `POST /:id/photos` `photos.ts:72` | только при создании черновика | дофото существующему: нет; порядок/удаление `photos.ts:422,465` нет |
| Объект: публикация на сайт | автосинхрон + `bulk-sync` | нет | `moderation.ts:183` (право `properties.publish`) |
| Объект: Корзина | restore/delete | restore_property, delete_property | жёсткое удаление `properties.purge` нет (и не надо) |
| Объект: ролик/озвучка | narration, remake | send_to_remake, озвучка (`assistantNarration.ts`, `assistantFreeNarration.ts`) | очередь монтажа `marketing.ts:771` нет |
| Подбор клиенту | `/clients/:id/match`, `/send-properties` | нет (есть `market_for_client` по чужому рынку) | `lib/clientPropertyMatching.ts::matchClientProperty`, `routes/clients/matching.ts:364,195` (логика отправки внутри маршрута, L) |
| Звонки | `/calls`, `/calls/incoming` | get_client_last_call | лента/пропущенные/без перезвона: `routes/calls.ts:66,446` инлайн; готово `lib/telephony/missedCallEscalation.ts::findCallbackContacts`, `countMissedCallsNoCallbackYesterday` |
| Переписки | `/conversations` | нет | чтение `conversations.ts:1204,1345` инлайн; отправка: `lib/conversationDelivery.ts::deliverToConversation` + проверки внутри `routes/clients/communications.ts:69` |
| Финансы/расходы/отчёты | экраны | get_finance_summary, 19 расходных | отчёты `lib/teamReports.ts::buildFunnelReport/buildAgentsReport/buildSourcesReport` и `lib/monthlyReport.ts` инструментом не поданы |
| Аналитика дня | пульт | get_company_stats, get_lead_sources (с датами, ca5535a3) | снимок пульта `lib/missionControlAsk.ts::buildAskContext`, `lib/morningNumbers.ts::loadMorningNumbers`, `lib/stuckPulse.ts::loadStuckPulse` |
| Контроль РОП | `/oversight/*` | нет | `overdueTasksWhere` (`routes/oversight.ts:96`, экспорт), `lib/noContact.ts::noContactWhere`, `lib/silentAfterShowing.ts::findSilentAfterShowing`; сами списки инлайн |
| Маркетинг | `/marketing/*`, `/social-videos` | нет | всё инлайн в маршрутах (`marketing.ts:184,597,771`); публикацию в соцсети давать только с подтверждением |
| Сотрудники/нагрузка | `/team`, `/agents` | list_staff, staff_now, get_staff_card | KPI агента `agents.ts:131`, баллы `lib/royalScore.ts::buildRoyalScoreView`, `lib/leaderboard.ts::loadWeeklyLeaderboard`, нагрузка `lib/agentLoad.ts::agentLoadCounts` не поданы |
| Уведомления | колокольчик | set_notification_pref | прочитать ленту `routes/notifications.ts:48` нет |
| Настройки/рубильники | `/settings` | нет, намеренно | оставить в CRM |
| Журнал ошибок | `/errors`, `/stuck-work` | нет | `lib/stuckWork.ts::listStuckWork`, `errorLog.ts:82` инлайн, право `auditLog.view` |
| Рынок (Somon) | `/market` | market_for_client, market_property_price | `market.ts:136` `overpriced` инлайн |
| Заявки команде | team-requests | нет | не исследовал (НЕТ ДАННЫХ) |

## 2. Что такое «мозг» в коде сегодня

ФАКТ — есть:
- База знаний компании: таблицы `AssistantKnowledge`, `AssistantKnowledgeRevision`, `AssistantKnowledgeEmbedding` (`schema.prisma:11516-11547`); `ai/assistant/knowledge.ts` (лексический поиск, запрет контактов/секретов в тексте), `knowledgeSemantic.ts` (эмбеддинги, включаются `ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED`, таймаут 2,5 с с откатом), утверждённые политики по темам (`knowledgePolicyQuery.ts`). Инструменты: search_company_knowledge (A), save/archive (C).
- Память диалога: Telegram `TelegramDialogState`, окно 15 мин (`assistantBot.ts` DIALOG_TTL_MS, `loadHistory/saveHistory`), `trimAssistantHistory` из shared; в CRM-чате историю держит клиент (`routes/ai.ts:167`). Долгой памяти о сотруднике/предпочтениях нет.
- Группа: `AssistantTelegramContext` (источник-ограниченный контекст группы, opt-in, TTL), «беззвучное участие» по шаблонам (`assistantGroupParticipation.ts`).
- Профиль контакта: `lib/contactProfileMemory.ts` есть (для клиентского бота, не для Шабнам; ОЦЕНКА).
- Журнал: `aiAssistantAudit.ts` (вопрос, инструмент, число строк, 90 дней), `AssistantAction` (карточки с превью/откатом).
- «Вопрос к данным» в пульте: `POST /dashboard/mission-control/ask` (`dashboardMissionControl.ts:786`, `lib/missionControlAsk.ts`, `ai/missionControlQa.ts`): отдельный ИИ-вопрос по снимку, никак не связан с Шабнам.
- Утренний брифинг текстом и голосом: `lib/morningBriefing.ts`, `routes/briefing.ts` (директору на главной).

ФАКТ — проактивность:
- Шабнам пишет сотруднику сама ТОЛЬКО через одну дверь `telegram/staffNotice.ts::sendStaffNotice` (вид PushKind, тумблер «🔕», dedupKey, журнал `StaffNotice`): платёжные напоминания (`lib/paymentReminders.ts`), раздать пост (`lib/agentSharePost.ts`), предложения объекта (`assistantPropertyOffers.ts`), удаление в Корзину (`trashRestoreNotice.ts`), плюс отдельно озвучка-согласование (`notifyNarrationApproval`), клип-ревью, монтажёр, заявки с Somon (`lib/somonLeads/*`).
- Утренняя сводка директору (`sendDirectorDigest`, cron `morning-report`, `cron.ts:~549`) и вечерняя агенту «на завтра» (`tomorrow-digest` 18:00, `lib/meetingReminders.ts::sendTomorrowDigest`), напоминания за час (`meeting-reminders`), десятки тревог (`agent-unanswered-alarm`, `buyer-no-call-alarm`, `supervisor-overdue-digest`, `director-alert-queue-flush`) идут веб-пушем и лентой (`push.ts`, `lib/directorAlertQueue.ts`), НЕ через Шабнам и НЕ разговорно. Это и есть пункт П8 из старого плана: не сделан.
- Кроны, связанные с помощником: `assistant-actions-sweep` (35 * * * *, `jobs/assistantActionsSweep.ts`), `assistant-log-retention`, `assistant-telegram-context-cleanup` (`cron.ts:1149,2375,2391`). Больше ничего.
- Правило владельца 10.11: редко беспокоить; любое сообщение отключается словами (уже сделано в staffNotice). Любая новая проактивность обязана идти через `sendStaffNotice` и вид PushKind.

ОЦЕНКА: «мозг» = хорошая справочная и исполнительная часть + база знаний, но нет (а) проактивных сводок от Шабнам, (б) долгой памяти о человеке и его делах, (в) аналитики по запросу «что горит» поверх уже готовых агрегатов, (г) разбора переписок и звонков.

## 3. Топ-15 новых возможностей

Порядок: чтение и аналитика, потом запись. Размер S/M/L. Тонкая обёртка = инструмент зовёт ту же функцию, что экран.

1. **Снимок дня компании** (директор, РОП). «Что сегодня горит?», «как дела у компании». Опора: `lib/missionControlAsk.ts::buildAskContext(seesMoney)` (право `dashboard.analytics`, деньги по `finance.view`) + `lib/morningNumbers.ts::loadMorningNumbers`. Риск: чтение. Размер S.
2. **Кто не отработал** (РОП, директор). «Кому не звонили 3 дня», «просроченные задачи по Фарруху». Опора: `routes/oversight.ts::overdueTasksWhere` (экспорт, стр.96), `lib/noContact.ts::noContactWhere`, `lib/silentAfterShowing.ts::findSilentAfterShowing`; списки внутри маршрутов (стр.455-600): выносить тело в `lib/oversightLists.ts`. Чтение. M.
3. **Мои дела на сегодня одной карточкой** (агент). «Что у меня сегодня?»: задачи, показы, новые непринятые лиды, кому перезвонить. Опора: `lib/tasks.ts::TASK_WHERE` + `get_upcoming_showings` + `lib/noContact.ts`; уже есть `list_my_tasks`, нужна сборка. Чтение. S.
4. **Пропущенные звонки без перезвона** (оператор, РОП). «Кто звонил и не получил перезвон». Опора: `lib/telephony/missedCallEscalation.ts::findCallbackContacts` и `countMissedCallsNoCallbackYesterday`; лента `routes/calls.ts:446` инлайн, право supervisor. Чтение. M.
5. **Разбор звонка** (агент/РОП). «Что клиент сказал в звонке, что договорились». Опора: `get_client_last_call` уже есть; добавить сводку `callAnalysis` по агенту/периоду (`routes/calls.ts:66` фильтр `problems=1`). Чтение. M.
6. **Прочитать переписку клиента** (агент по своим, РОП по всем). «Что клиент писал в WhatsApp?». Опора: `routes/conversations.ts:1345` + скоуп `lib/chatScope.ts::conversationBelongsTo`, `lib/callTranscripts.ts` (маски номера); тело в `lib/`: вынос. Чтение (телефоны маскировать `assistantContacts.ts`). M.
7. **Нагрузка и рейтинг команды** (РОП, директор). «Кто перегружен», «таблица недели». Опора: `lib/agentLoad.ts::agentLoadCounts`, `lib/leaderboard.ts::loadWeeklyLeaderboard`, `lib/royalScore.ts::buildRoyalScoreView`, `agents.ts:131` KPI. Чтение. S.
8. **Отчёты за период** (директор). «Воронка за неделю», «скорость ответа», «спрос-предложение». Опора: `lib/teamReports.ts::buildFunnelReport/buildAgentsReport/buildSourcesReport`, `lib/responseSpeed.ts::loadResponseSpeed`, `lib/demandSupply.ts::loadDemandSupply`, `lib/monthlyReport.ts::buildMonthlyMetrics`. Деньги: `finance.view`. Чтение. M.
9. **Совет по цене и «горячесть» объекта** (агент). «Почему ОБ-123 не продаётся, что советуешь?». Опора: `lib/loadPriceAdvice.ts::loadPriceAdvice(id,{dealsOwnAgentId,viewerId,visibleToAgentId})` (`stats.ts:149`), `lib/propertyHeat.ts::loadPropertyHeat`. Чтение. S.
10. **Что не доехало / сбои** (директор). «Что сломалось ночью». Опора: `lib/stuckWork.ts::listStuckWork`, `lib/integrationHealth.ts::check*Health`, `loadStuckPulse`; право `auditLog.view`. Чтение. S.
11. **Проактивная утренняя и вечерняя сводка от Шабнам** (все роли). Не «тарабарщина пушем», а одно сообщение в личку: план дня агенту, итог дня директору. Опора: `lib/meetingReminders.ts::sendTomorrowDigest`, cron `morning-report`, дверь `telegram/staffNotice.ts::sendStaffNotice` + новый PushKind, тумблер. Правило «редко беспокоить»: одна сводка, вне её только серьёзное. Сообщение сотруднику. M.
12. **Вернуть клиента из Корзины; отказ клиента** (агент по своим, РОП). «Верни Умеда из корзины», «оформи отказ: дорого». Опора: `lib/restoreClient.ts::restoreClientFromTrash` (S), `lib/clientRefuse.ts::refuseClient` + `checkRefusalPreconditions` (M). Запись чужого/своего, уровень C с откатом где возможно. S/M.
13. **Принять лид / дубли и слияние** (агент; РОП). «Прими лид Умеда», «покажи дубли». Опора: `lib/leadAccept.ts::acceptLead`; `lib/duplicateClients.ts::findDuplicateClientGroups`, `lib/clientMerge.ts::mergeClients` (слияние необратимо, право `clients.merge`). S/M.
14. **Править поля клиента голосом** (агент). «Бюджет Умеда 80 тысяч долларов, район Сино». Опора: двери нет, `PATCH /clients/:id` (`card.ts:1136`) инлайн: сначала вынос в `lib/clientUpdate.ts` (маска номера, `assertClientWritable`/`foreignWriteDenied` из `lib/clientWriteAccess.ts`), затем плагин C. Запись своя. L.
15. **Подборка объектов клиенту и отправка** (агент). «Подбери Умеду варианты и пришли ему». Подбор: `lib/clientPropertyMatching.ts::matchClientProperty`, `routes/clients/matching.ts:364`; отправка: `matching.ts:195` + `lib/conversationDelivery.ts::deliverToConversation`. Сообщение клиенту: ТОЛЬКО карточка с точным текстом и кнопкой, вынос тела маршрута. L. Подбор без отправки (чтение) можно раньше (M).

Следующая очередь (не в топ-15): дофото существующему объекту (`photos.ts:72`), публикация на сайт (`moderation.ts:183`, `properties.publish`), очередь монтажа (`marketing.ts:771`), вакансии, реклама Meta (чтение), лента уведомлений, `get_property_card` по неопубликованным.

## 4. Нельзя без подтверждения или вообще

Механизмы, которые переиспользовать:
- Брокер подтверждений `lib/assistantActions.ts` (`createPendingAssistantAction`, `confirmAssistantAction`, `undoAssistantAction`; карточка «было → станет», TTL 10 мин, откат 15 мин, `irreversible` в превью, идемпотентность, `requires` права, `channels`, `privateTelegram`). Любой новый плагин записи = `AssistantWriteToolPlugin` уровня C.
- Step-up: `executor.stepUp: true` (CRM: окно `lib/stepUp.ts::isElevated`; Telegram: код Authenticator `telegram/assistantStepUp.ts`, `lib/totp.ts`, пять ошибок = блок 15 мин).
- `tools/privateWriteAllowed.ts` (запись только в личке, не в группе), `GROUP_HIDDEN_TOOLS` в `telegram/assistantBot.ts:157` (новый инструмент с деньгами/клиентами дописать туда), `MAX_WRITES_PER_ANSWER = 3` (`assistant.ts:1360`), `claimAgentAiAction` (суточные потолки), `moneyBudget.ts`, `wrapUntrusted` (`ai/untrustedContent.js`: чужой текст из переписок это данные, не команды).
- Одна дверь исходящих сообщений сотруднику: `staffNotice.ts`; клиенту: `lib/conversationDelivery.ts::deliverToConversation` + предохранитель `lib/outboundShield.ts`.

Список:
1. Сообщения клиентам (ответ в чате, рассылка, подборка): только карточка с точным текстом и «Подтвердить», штатная дверь; никаких «ответь сам». Правило владельца: реальному клиенту только с «да» на конкретный текст.
2. Деньги: комиссия, выплаты, оплата расходов, цена проданного/в резерве, `deals.setCommission`: уже C; в группе закрыты; новые деньги-инструменты дописывать в `GROUP_HIDDEN_TOOLS`.
3. Жёсткое удаление (`clients.purge`, `properties.purge`, слияние клиентов, удаление сотрудника): либо не давать, либо C + `irreversible` + step-up.
4. Права, роли, 2FA, пароли, ключи, настройки, рубильники, интеграции: права/сотрудники уже step-up; ключи и настройки оставить в CRM (решение 10.11).
5. Публикация в соцсети и снятие (`requireMarketingRole`, `social-unpublish`, tiktok/stories): только C, роль маркетинга; необратимо для чужих сетей.
6. Звонки наружу и робозвонки (`communications.ts:370,538`), СМС (`sms.ts`): только C с номером и текстом.
7. Чтение разговоров и записей: `calls.transcripts`/`calls.hearRecording`/`clients.viewPhone` проверять на сервере; в группе не отдавать (в `GROUP_HIDDEN_PERMISSIONS` уже).
8. Расследования/СБ (`canViewInvestigations`, `investigationOnly`): только директор/админ, в ответ не включать, `visibleInteractionWhere` как в `runTool`.
9. Массовые записи («закрой все просроченные»): лимит 3, превью списком, по одному правилу владельца.

## 5. Риски и предусмотреть
- Многие «двери» сидят внутри маршрутов (calls, conversations, oversight, marketing, clients PATCH, matching/send). Правило проекта «одна дверь»: сначала вынос в `lib/`, экран и инструмент зовут одно (ОЦЕНКА трудоёмкости L у четырёх позиций).
- Нагрузка на модель: объявленных инструментов уже ~75 (10 встроенных + плагины); Gemini хуже выбирает при росте списка. Нужен Golden Set (правило владельца «архитектура сначала») и, возможно, группировка/роутинг по роли (`allowed(actor)` уже есть). ОЦЕНКА.
- Стоимость и потолки: 150 ходов/день, 40 голосовых (`ASSISTANT_TG_DAILY_LIMIT`); проактивные сводки лучше строить кодом из готовых чисел, без вызова модели.
- Тесты: каждый плагин в `tests/ai-assistant-tool-registry.test.ts`/`assistant-staff-rights.test.ts` стиле; новый инструмент в группе Telegram сверяется сторожем.
