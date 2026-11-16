# 14.11.2026: молчаливые поломки доходят до директора (PR-1)

Источник: охота на «внезапно и молча» (находки Д1, Д3, Д4, Д6a, Д7, Д8). Ветка `fix/silent-alarms-door-14-11`.

## Что и почему

- **Д1, живой worker.** `deepHealth` брал максимум `lastRunAt` по всем строкам пульса, включая тики процесса API
  (`live-voice-spend-ceiling` раз в минуту). Зависший worker выглядел живым, сторож сервера его не перезапускал,
  а в worker живут тревоги, утренняя сводка, Шабнам и монтажёр. Теперь строки `API_PROCESS_TICKS` в расчёт не входят.
  Класс «кто ещё считает жив по общей таблице пульса»: других агрегатов по `cronHeartbeat` в коде нет
  (`missionControlAsk` и `dashboardMissionControl` только показывают список).
- **Д3, одна дверь срочной тревоги.** `lib/channelKeyAlarm.ts`: общая `raiseCriticalAlarm` (CRITICAL + `urgent`, то есть мимо окна
  часов алармов, как в PR #174 через `enqueueDirectorAlert`; одна метка на поломку; не чаще 12 ч; замок на метку).
  `raiseChannelKeyAlarm` теперь её частный случай. Общий пуш «новая проблема» НЕ возвращён (решение владельца 02.10),
  заглушка `notifyDirectorsAboutNewError` не тронута, это проверяет тест.
  Звонят в дверь:
  - `cronHeartbeat.ts`: тик снят по таймауту и сторож «крон молчит», метка `cron-silent:<тик>` (закрытые крон-задачи расследований наружу не светим);
  - `integrationHealth.ts::alertOnIntegrationBreakage` (вызов в `cron.ts` до записи снимка): только при переходе «жив / не настроен / нет снимка → сломан», метка `integration:<имя>`;
  - `telegram/poller.ts`: обрыв приёма сообщений дольше 3 мин, метка `telegram-poller`;
  - `narrationAutoFlow.ts` и `ai/liveVoiceProvider.ts`: кончились кредиты ElevenLabs, метка `elevenlabs-quota` (общая для озвучки, робозвонка и будущей суточной проверки остатка из PR-2).
- **Д4, сторож копий.** `lib/backupFreshness.ts` + новый тик `backup-freshness` (`17 * * * *`, раз в час): последняя удачная выгрузка OFFSITE старше 26 ч или её нет, либо последний прогон какого-то вида провалился и позже успеха этого вида не было. Метка `backup:<вид>`.
- **Д6a.** `BILLING_RE` узнаёт «кредиты ... закончились», «закончились минуты/кредиты» и `quota_exceeded`: напоминание об оплате теперь срабатывает и на озвучку.
- **Д7, пульс Telegram-поллера.** Новая строка пульса `telegram-poller` (расписание «каждую минуту», бьётся каждый виток цикла не чаще раза в минуту). Это тик worker: `deepHealth` его учитывает как жизнь worker. Ожидание регистрирует сам поллер при старте (`registerLoopHeartbeat`), поэтому без токена Telegram или в режиме вебхука ложной тревоги нет.
- **Д8, «тик начался и не закончился».** `checkCronHeartbeats`: `lastRunAt > lastOkAt`, `lastError` пуст, и с запуска прошло больше таймаута тика + 5 мин (таймаут теперь хранится в реестре). Одна тревога на запуск. Фикстура месячного тика в старом тесте приведена к реальности (здоровый тик имеет `lastOkAt`).

## Чем проверено

- `tsc --noEmit` в `apps/api`: 0; `build:shared` и `build:api` из precheck зелёные.
- Новые и затронутые тесты в своей базе стенда (`agent_4115`): `silent-alarms-door` (13), `health-deep` (6), `cron-heartbeat` (15),
  `cron-heartbeat-timeout` (4), `director-alert-queue` (6), `director-alert-urgent` (10). Смежные (23 файла: крон-тесты, meta-eternal-tokens,
  payment-reminders, assistant-telegram, narration-auto-flow, live-voice-spend-ceiling и др.) зелёные; единичные «Hook timed out» и
  «Connection terminated» были от нагрузки машины (4 параллельных исполнителя), на повторе зелёные.
- Красное без правки: Д1 (`health-deep`: без `where notIn` worker «жив» по строке API) подтверждено. Д8 отдельно без правки не прогонялось.
- Находка по ходу: тик, снятый по таймауту, не должен ждать дверь под замком тика: тревога ставится без `await`, иначе следующий запуск пропускался бы на время записи в базу.
  Тесты, которые ловят снятый тик, чистят свои тревоги (`cron-silent:test-…`), иначе очередь тревог соседнего файла доставит чужую строку.
- Не проверено: `build:web` и `npm run precheck` целиком (в worktree нет зависимостей фронта: `@typescript-eslint/parser`; фронт не менялся);
  полный `test:api` (его гоняет `npm run ship`); живые вызовы внешних сервисов не делались.
- Остальные шаги precheck по одному: `audit:deps:gate`, `audit:theme`, `audit:nginx`, `audit:typeset`, `audit:rules`, `audit:mocks`,
  `audit:audit-labels`, `audit:secrets`, `map:check`, `map:gate` зелёные.

## Новое имя тика для страницы «Состояние функций»

`telegram-poller` (строка `CronHeartbeat`, только когда поллер реально запущен) и `backup-freshness` (обычный тик, `17 * * * *`).
