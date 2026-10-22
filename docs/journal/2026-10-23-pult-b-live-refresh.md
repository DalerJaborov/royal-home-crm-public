# Пульт: живое обновление за секунды (пачка B)

Дата: 2026-10-23. Ветка: fix/pult-b-23-10.

## Что изменилось
- Кэш секций пульта сбрасывается событиями (`publishClientUpdated/DealUpdated/CallUpdated/LeadPending/LeadAccepted/PropertyUpdated/RequestUpdated` — всё; `message.new`, `conversation.updated`, `pult.snapshot` — только живые секции). Сброс без повторной публикации (цикла нет); расчёт, начатый до сброса, в кэш не попадает.
- Листовой модуль `lib/pultCacheHook.ts` связывает livePublish и missionControlCache без цикла импортов; `requestPultSnapshot()` можно звать из любого места.
- `publishPultSnapshot()` — не чаще раза в 5 с на процесс (первый вызов сразу, остальные — один отложенный выстрел в конце окна), адресат — OVERSEER_ROLES. Источники: новая ошибка в журнале (systemError), приём/публикация/проверка ролика (videoHandoff, clipReview), новые комментарии IG (commentsQueue), новый запрос «перезвоните» (callbackRequests).
- Сообщения клиента и пауза бота уже публикуют `message.new`/`conversation.updated` — теперь они гасят `["mission-control"]` на клиенте, отдельный снимок не нужен.
- Клиент: волна пульта раз в 3 с (счётчики и сводка — по-прежнему 10 с), `lastEventId` в URL переподключения, после обрыва — инвалидация ON_RESUME.
- Сервер: `replayMissedEvents` доигрывает события из LiveEventOutbox (TTL 5 мин) по `lastEventId`/`Last-Event-ID`.

## Проверено
Тесты: `apps/api/tests/pult-live-refresh.test.ts`, `apps/web/src/lib/__tests__/liveEventsPult.test.ts`; задетые live-events*, mission-control-cache*. Сборка api/web.

## Осталось
Серверный воспроизвод пропущенного проверен только на уровне кода (без боевого потока). Страховочный опрос useMissionControl не менялся.
