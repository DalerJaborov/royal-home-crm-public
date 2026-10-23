# 23.10.2026 — Пульт директора, пачка A: данные сервера

- Что изменилось (`routes/dashboardMissionControl.ts`, `lib/missionControlGaps.ts`, `lib/dashboardInsights.ts`):
  1. «Клиент завис» (`hero.dealsInPipeline.items`): клиенты в воронке без работы 3+ дня по `Client.lastContactAt` (метка работы сотрудника; входящее сообщение её не двигает), самые давно молчащие первыми, предел 5, один запрос. Новое: `stuckTotal`, `stuckDays`, у строки `silentDays`.
  2. `system.unresolvedTotal` — все нерешённые ошибки. `POST /errors/resolve-all {scope:"all"}` уже был; сегодняшнее поведение не тронуто.
  3. `marketing.channels.problems[]` (канал, текст, checkedAt, fixPath) из `IntegrationHealthSnapshot.ok=false`, `healthCheckedAt`, `openaiOutOfMoney` (нерешённая ошибка за 24 ч с «insufficient_quota / закончились деньги / billing_hard_limit_reached»).
  4. `marketing.instagramCommentsWaiting` уже отдавался — проверено тестом.
  5. `hero.commission.planIsDefault` — план равен 8000 (колонка NOT NULL, «не задан» от «задан 8000» не отличить).
- Почему: аудит пульта 23.10.2026 (docs/design/dashboard-audit-2026-10-23).
- Чем проверено: build:api; vitest mission-control-pult-a (новый), mission-control-l2-t3 (фикстура клиента состарена), mission-control, -phase4, -gaps, dashboard-insights-money, finance-commission-forecast, errors-resolve-all-today.
- Что осталось: фронт читает новые поля (другие пачки). Все поля необязательные.
