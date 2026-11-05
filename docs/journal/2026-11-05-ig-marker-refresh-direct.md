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
