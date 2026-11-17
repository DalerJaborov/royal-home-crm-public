# 2026-10-23 — Ядро клиентского агента: хвосты после пачек A–F (задание G)

## Что изменилось
1. **Ссылки `facebook.com/share/p|r|v/<код>` и `fb.watch/<код>`.** `customerPropertyShareLink` (`lib/customerPropertyUrls.ts`) узнаёт их и даёт
   каноническую форму; чистый разбор `customerPropertyUrl` по-прежнему НЕ ходит по сети и отвечает «unsupported/denied».
   Доказательство из текста/вложения теперь `url` (а не «формат не поддерживается»); `fb.watch` распознаётся и без `https://`.
   Резолвер (`customerPropertyResolver.ts`) один раз раскрывает такую ссылку через `registry.expandShare` →
   `expandCustomerShareLink` (`lib/customerShareLinkExpansion.ts`): ОДИН GET с `redirect:"manual"`, `credentials:"omit"`, без cookie/токенов, таймаут 5 с,
   читается только заголовок `Location` (тело отменяется), перед запросом — общий SSRF-страж `assertPublicUrl`. Назначение принимается только если
   `https`, без логина/порта и хост из `facebook.com / www / m.facebook.com / instagram.com / www.instagram.com`; дальше его разбирает
   существующий парсер (пост → `media`, `/p/` → `instagram`). Результат кешируется как у обычной ссылки: фокус хранит найденный объект.
   Неприменимый ответ (нет редиректа, вход-в-аккаунт, чужой хост) → `denied/unsupported`; таймаут, сеть, 429/408/5xx → исключение →
   `lookup_unavailable` + `logSystemError` (`customer-property-lookup-failed`). Немедленный повтор внутри хода берёт итог раскрытия из памяти:
   сетевой запрос ровно один.
   *Почему это безопасно, хотя «редиректы в ядре запрещены»:* запрет стоял в парсере и касался чужого URL, по которому сервер дошёл бы куда угодно.
   Здесь старт — фиксированный хост Meta, редирект НЕ выполняется (его цель только сверяется со списком и разбирается как текст), запрос анонимный.
2. **Повтор разбора ссылки на следующем ходе.** В фокус добавлено `lookupAttempts` (1..2, `packages/shared`). Сбой чтения (`lookup_unavailable`) ставит
   счётчик; на следующем входящем БЕЗ новой ссылки `resolveCustomerPropertyTurnContext` переоткрывает фокус (`reopenCustomerPropertyFocusForRetry`:
   compare-and-set по ревизии, владелец — прежнее событие) и читает ещё раз. После второй неудачи счётчик = 2, повторов больше нет. Любая новая
   ссылка создаёт новый фокус без счётчика, определённый ответ («не найдено») счётчик снимает. `customerPropertyUnresolvedReason` теперь отдаёт
   `lookup_unavailable` (раньше эта причина в рендерере была мёртвой), так что клиенту честно говорится «временный сбой».
3. **Адресат комментария в контекст модели.** `publicState.addressee` (`company | other_person | reaction | self_promo | unknown`, опционально,
   `packages/shared/src/customerState.ts`). Сервер считает его из структуры ветки/упоминаний/текста (`customerPublicAddresseeLabel`), пропуск
   «другому человеку / реакция» остаётся серверным. Публичный ход теперь всегда отдаёт модели `verifiedContext` (раньше без ветки — ничего), в системный
   промт добавлена строка про поле. Меняются `modelSchemaHash`, `knowledgeSchemaHash`, `promptHash` и `coreHash` — после выката нужно «Обновить версию бота».
4. **F12 с базой — найден и починен баг.** Сценарий «A отложен из-за B, B кончился HELD» на деле не работал, если B успел дойти до принятия FINAL:
   `canonicalOriginCurrent` требует, чтобы последним принятым в обращении был именно этот вход, поэтому A после принятого B навсегда
   `original_final_stale`, а возобновление A (прежний код) молча упиралось в это. Теперь `resumeDeferredCustomerInbox`: B не принят → как прежде
   возобновляется A; B принят и не получил ответа/исходящих → B перезапускается ОДИН раз (задание `customer-inbox-resume:<B>`, через 15 с), а
   отложенные строки помечаются `newer_input_resumed` (их слова всё равно добавляются в ввод B, но второй сбой B уже ничего не возобновит —
   цикла нет). Платная операция B, если модель уже вызывалась, закрыта (`operation_closed`) и повтор невозможен — это прежнее правило учёта, не менялось.

## Чем проверено
- `npm run build:shared`, `npm run build --workspace=apps/api`, `npm run build --workspace=apps/web` — код 0.
- Новые тесты, до правки красные: `customer-core-tails-23-10` (чистый, 15), `customer-core-tails-lookup-retry-postgres` (5, с базой),
  `customer-deferred-input-postgres` (4, с базой), плюс два случая в `customer-public-agent-postgres` (адресат доходит до модели по настоящему проводу).
  Обновлено одно старое ожидание в `customer-agent-render-core-23-10` (share-ссылка теперь `url`).
- `npx vitest run customer-property customer-public customer-dm-agent-turn-postgres customer-deferred customer-agent-core customer-core-tails customer-agent-render-core customer-newer-inbox`
  — 25 файлов, 510 тестов зелёные; смежные (`customer-agent-golden`, `customer-dm-media`, `customer-ingress*`, `customer-state`, `customer-actions-postgres`) — 169 зелёные.

## Что осталось
- Реальный ответ Meta на `facebook.com/share/…` для анонимного запроса не проверялся (сеть закрыта): если Facebook ведёт анонима на страницу входа,
  ссылка честно остаётся «unsupported». Нужна проверка на живой ссылке после выката.
- Повтор B после закрытой платной операции невозможен; если и такие ходы нужно «добирать», это отдельное решение по учёту операций.
- После выката — «Настройки → Новый бот → Обновить версию бота».
