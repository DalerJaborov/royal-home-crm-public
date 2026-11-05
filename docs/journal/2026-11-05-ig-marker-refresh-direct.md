# 05.11.2026 — продление маркеров Instagram на сервере в Германии

**Что было.** 04.11 в 20:20 UTC ночное продление упало для обоих аккаунтов
(«Royal Home», «Royal Home Info»): `Graph API HTTP 400: The parameter access_token
is required`. Причина — переезд: на Beget (Россия) запросы к graph.instagram.com
шли через прокси, а он сам переносил маркер в строку запроса. На netcup
`IG_PROXY_URL` и `GEMINI_PROXY_URL` пустые, `instagramRequest` шлёт обычный
Bearer-заголовок, а `refresh_access_token` маркер из заголовка не читает. Маркеры
продлены 27.10 и живут 60 дней: без починки оба умерли бы около 26.12, и
Instagram замолчал бы целиком (директ, комментарии, публикации, лента на сайте).

**Что изменилось.** `messengers/metaGraph.ts` — `instagramQueryTokenRequest`:
маркер всегда в строке запроса, ровно один раз, без Bearer. `instagramFeed.ts`
продлевает через него. Остальные вызовы Instagram не тронуты: обычные адреса
Graph Bearer принимают (ответы в директ после переезда уходили).

**Чем проверено.** `tests/instagram-token-refresh.test.ts`: +2 теста (без прокси —
`access_token` в строке и нет Authorization; через прокси — маркер один раз).
Сторож проверен поломкой: со старым вызовом тест «без прокси» красный, с
починкой — 9/9. `build:shared`, `build:api` — код 0.

**Что осталось.** После выката — дождаться ночного тика 20:20 UTC (или нажать
продление) и убедиться, что `MessengerAccount.tokenRefreshedAt` сдвинулся.
Полный разбор переезда — `experts/2026-11-05/migration-audit/` вне репозитория.

## Там же: ключ прокси Gemini больше не уходит в Google

`ai/geminiTransport.ts::geminiProxyHeaders` отдавал `x-proxy-key` при одном лишь
заданном `GEMINI_PROXY_KEY`. На netcup адрес прокси пуст, ключ в окружении остался —
секрет нашего Worker уходил заголовком прямо в Google в каждом вызове Gemini.
Теперь ключ идёт только вместе с `GEMINI_PROXY_URL`. Тест
`tests/proxy-direct-egress.unit.test.ts` (4) — проверен поломкой: старый код красный.
Владельцу/выкату: убрать `GEMINI_PROXY_KEY`/`IG_PROXY_*` из `.env.production`
после недели тишины, удалить Worker `red-mouse-517a`.

## Там же: остановка нового бота — пуш директору сразу

03–05.11 ядро бота стояло двое суток (после выката код ≠ активной версии
8264c103), молчали комментарии и директ Instagram, WhatsApp, Facebook. Сигнал
был только строкой в журнале и в утреннем отчёте. `lib/customerAgentRevisionAlert.ts`
теперь после записи в журнал ставит одну тревогу CRITICAL директору/админу через
общую дверь `enqueueDirectorAlert` со ссылкой на кнопку «Обновить версию бота»
(`/settings?tab=bot&task=rollout`); повтор гасит метка за сутки (api и worker
проверяют версию при старте оба). Общая рассылка об ошибках (убрана 02.10) не
возвращается. Тесты `customer-agent-revision-alert` 12/12 (+3), проверено поломкой.

## Там же: сотрудник может ответить на комментарий, на котором сдалось ядро

Кнопка «Ответить» на экране «Комментарии» для FAILED `managed_core:failed:*`
всегда получала 409 «Публикация удержана». Две причины в
`lib/customerPublicManualReply.ts`: статус пускал только PENDING/ERROR, а смена
статуса на FAILED по триггеру `customer_public_source_revisions` поднимает
ревизию на 1, и проверка «ревизия = ревизии при приёме» не проходила никогда.
Теперь FAILED с пометкой ядра (ядро ставит её только без единой части в outbox,
`priorParts` проверяет это под замком) берётся сотрудником при ревизии ровно
«приём + 1»; в пломбе `originalSourceRevision` = ревизия при приёме (для
PENDING/ERROR это то же число). FAILED по другой причине закрыт, как раньше.
Тесты `customer-public-comment-manual-postgres` +2 (новый красный на старом коде),
вместе с `customer-public-agent-postgres` 74/74.
