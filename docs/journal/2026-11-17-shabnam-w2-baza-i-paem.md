# 17.11.2026 — Шабнам: разбор клиентской базы и сообщение коллеге

- **Что изменилось.**
  - **`get_client_base_overview`** (чтение, `ai/assistant/tools/clientBaseOverviewTool.ts`):
    одним ответом — всего клиентов, в работе (покупатели/продавцы/прочие), из них без
    контакта и ждут принятия, не в работе по причинам (сделка закрыта, Архив, работа
    завершена и ждёт руководителя), заявки на удаление, отказы «Без сделки» за 30 дней
    с причинами (журнал `CLIENT_REFUSE`), Корзина с причинами (одобренные заявки на
    удаление) и, руководству, по агентам. Агент без `clients.viewAll` — только свои.
    Ответ несёт `period`, `meaning` (что значит каждое число) и готовый `display`
    на ru/tg. Только личка: в общей группе скрыт (`GROUP_HIDDEN_TOOLS`) и отказывает.
  - **Одна дверь с экраном «Клиенты».** База сводки (`GET /clients/summary`) и условие
    «ждут принятия» вынесены из маршрута в `lib/clientBaseOverview.ts`
    (`clientsScopeBaseWhere`, `awaitingAcceptanceWhere`); маршрут и помощница зовут их
    оттуда, тест сверяет числа помощницы с ответом маршрута.
  - **`send_staff_message`** (запись уровня C, `ai/assistant/tools/sendStaffMessageTool.ts`):
    «напиши коллеге, чтобы оплатил» — сообщение коллеге в Telegram от имени просящего.
    Получатель — только действующий сотрудник с привязанным Telegram, по имени через
    `lib/agentNameLookup.ts` (несколько совпадений — кандидаты модели; имя в падеже —
    вторая попытка без окончания); номер, @ник, ссылка вместо имени — отказ; клиенты
    не ищутся вовсе. Карточка показывает точный текст и получателя, необратима; после
    «Подтвердить» — `sendStaffNotice` с новым видом `staff_message` (подпись «Сообщение
    от …» ставит код, текст экранирован, ключ повода — id действия). Себе нельзя,
    акционеру нельзя, в общей группе скрыт, ≤ 1000 знаков, ≤ 20 в сутки по Душанбе
    на отправителя. Журнал — `ASSISTANT_SEND_STAFF_MESSAGE` через брокер.
  - **Новый вид уведомлений `staff_message`** («Сообщения от коллег») в
    `packages/shared/src/push.ts`: выключается кнопкой «🔕 Не присылать такое», словами
    («не присылай мне сообщения коллег» — `telegram/staffNotice.ts`) и в профиле.
    Вид — строка в `Agent.pushMuted`/`StaffNotice.kind`, enum в базе нет — **миграция
    не нужна**.
  - Карточка подтверждения в Telegram (`renderBundleCard`) показывает текст сообщения
    коллеге целиком, без обрезки до 120 знаков.
- **Что значит «неактивный» по коду.** Статусов нет с 16.11.2026 (#220/#222):
  `workStatus` у всех ACTIVE и не читается. «В работе» = `CLIENT_IN_WORK_WHERE`
  (`lib/clientInWork.ts`): не в Корзине, без закрытой сделки, не Архив, работа не
  завершена. Всё прочее и «без контакта» (`lib/noContact.ts`) — то, что директор
  называет неактивными; инструмент так и объясняет модели.
- **Почему.** Журнал Шабнам 17.11: директор дважды просил разбор базы, сотрудники
  просили передать сообщение коллеге — инструментов не было.
- **Чем проверено.** Только чтением кода: в рабочей копии нет `node_modules`, сборка и
  тесты не запускались. `docs/product-flows.*` пересобраны (`node scripts/product-flows.mjs`);
  `product-map.mjs` требует пакет `typescript` и не запускался.
  Тесты: `apps/api/tests/ai-assistant-client-base-overview.test.ts`,
  `apps/api/tests/ai-assistant-send-staff-message.test.ts`, имена — в
  `ai-assistant-tool-registry.test.ts`.
- **Что осталось.** Сборщику: `npm run build:shared && npm run build:api`,
  `npm run map && npm run map:check`, прогон
  `cd apps/api && npx vitest run tests/ai-assistant-client-base-overview.test.ts tests/ai-assistant-send-staff-message.test.ts tests/ai-assistant-tool-registry.test.ts tests/clients-summary.test.ts tests/shabnam-notify-mute.test.ts tests/staff-notice-one-door.test.ts tests/no-client-status-folders.test.ts`.
  Получатель без Telegram сообщения не получит (только отказ с подсказкой) — копии в
  ленту уведомлений CRM пока нет.
