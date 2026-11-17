# 17.11.2026 — Шабнам «мозг компании»: шесть сводок для чтения

- Что изменилось: новый файл `apps/api/src/ai/assistant/tools/brainReadTools.ts`, подключён
  строкой в `tools/index.ts`. Шесть инструментов чтения (уровень A), каждый — обёртка над той же
  функцией, что рисует экран CRM:
  - `get_day_snapshot` — снимок дня компании (пульт: `buildAskContext`, `loadMorningNumbers`,
    `loadShowingsToday`); право `dashboard.analytics`, деньги — только с `finance.view`;
  - `get_unworked` — кто не отработал: просрочки, без контакта, тишина после показа
    («Контроль руководителя»); руководству — вся компания с разбивкой по сотрудникам и
    фильтром по имени, без `dashboard.analytics` — только своё;
  - `get_my_day` — «мои дела сегодня»: `list_my_tasks` + свои непринятые заявки, свои
    пропущенные без перезвона, свои клиенты без контакта;
  - `get_missed_calls` — пропущенные без перезвона: `calls.transcripts` — все,
    `calls.ownTranscripts` — только свои (`ownIncomingCallsOr`), без прав — отказ;
  - `get_team_load` — нагрузка «Команды» (`agentLoadCounts`, `team.viewFull`) и рейтинг недели
    (`loadWeeklyLeaderboard`, `dashboard.analytics`); без прав — своя нагрузка;
  - `get_stuck_work` — «Что не доехало» (`listStuckWork`) и сломанные доступы из снимка
    самопроверки; право `auditLog.view`.
  Общее: только личка (в `GROUP_HIDDEN_TOOLS` + отказ в самом инструменте), списки ≤ 10 строк и
  «ещё N», маски телефона и источника, Корзина не показывается, время по Душанбе, готовый текст
  ru/tg в поле `display`; описания с фразами на русском и таджикском.
- Одна дверь (вынесено из маршрутов, поведение экранов не менялось):
  - `overdueTasksWhere` → `lib/tasks.ts` (маршрут `oversight.ts` импортирует и переизлучает);
  - выборка «пропущенные без перезвона» → `lib/telephony/missedCallEscalation.ts::missedWithoutCallbackIds`
    (маршрут `GET /calls/incoming?noCallback=1` зовёт её);
  - чтение снимка самопроверки → новый `lib/integrationHealthSnapshot.ts` (маршрут `/integrations`).
- Сторожа: имена в `GROUP_HIDDEN_TOOLS`, `tests/ai-assistant-tool-registry.test.ts`, ссылки на карточки —
  `cardLinkEvidence.ts` (get_unworked, get_my_day, get_missed_calls) и `NOT_CARD_LINKS` в
  `tests/assistant-market-card-links.test.ts` (остальные три).
- Почему: владелец 17.11 — «самого настоящего умного мозга компании»; аудит: Шабнам почти не
  пользуются, на простые вопросы дня отвечала неверно (HANDOFF `docs/HANDOFF_2026-11-17-shabnam-brain.md`,
  `docs/design/shabnam-brain-2026-11-17/recon-gaps.md` пункты 1, 2, 3, 4, 7, 10).
- Чем проверено: только чтением кода (сигнатуры и типы сверены по исходникам и `schema.prisma`,
  циклы импортов — скриптом по графу). Сборка и тесты НЕ запускались (на машине нет памяти и
  `node_modules` в копии). Новый тест: `apps/api/tests/ai-assistant-brain-read-tools.test.ts`.
- Что осталось: сборка api, прогон тестов (новый файл + `ai-assistant-tool-registry`,
  `assistant-market-card-links`, `assistant-card-link-evidence.unit`, тесты маршрутов звонков,
  контроля и интеграций), `npm run map`, `npm run precheck`; живая проверка фразами
  «кӣ кор накард», «имрӯз чӣ кор дорам». Не сделано: отчёты за период (`teamReports`), разбор
  звонков, переписки — следующие пункты recon-gaps.
