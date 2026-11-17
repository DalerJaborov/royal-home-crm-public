# HANDOFF 17.11.2026 — класс «большой файл одним запросом → 413 от прокси»

## Что случилось
Экран «Ролики в соцсети»: ролик 87 МБ → «Файл слишком большой для отправки.» (HTTP 413 без JSON,
ответ ПРОКСИ, а не API). Цепочка: браузер → Cloudflare (proxied, лимит тела 100 МБ; замер 17.11:
95 МБ проходит, 105 МБ → 413 `Server: cloudflare`) → Caddy на хосте 62.83.97.196 (`/etc/caddy/Caddyfile`,
лимит неизвестен — ssh из чата классификатор не пустил; 87 МБ отбился, значит за ним ещё что-то режет
или Caddy max_size/таймаут) → nginx web (`apps/web/nginx.conf`) → API (multer).
Приложение обещало 2 ГБ (multer + nginx 2100m), цепочка столько не пропускает.

## Уже сделано (ветка `fix/social-video-chunked-upload-17-11`, worktree `D:\CRM-wt\social-chunk`, коммит a31113ab4)
Свободный ролик грузится частями по 8 МБ: `lib/socialVideoUploadSessions.ts`, маршруты
`/social-videos/upload-sessions` (старт/часть/сборка), клиент `apps/web/src/lib/socialVideoUpload.ts`,
nginx-блок, тесты (web 6/6, api 58/58). Журнал `docs/journal/2026-11-17-social-video-chunked-upload.md`.
Выкладку (`npm run ship`) доводит прежний чат.

## Задача новой сессии — весь класс, раз и навсегда
1. Найти ВСЕ пути, где файл уходит ОДНИМ запросом и может быть > ~90 МБ:
   - сервер: каждый multer в `apps/api/src/upload.ts` и в `routes/*` (`limits.fileSize`), `express.raw` с большим `limit`;
     известные кандидаты: `POST /properties/:id/videos` (700 МБ), `/:id/clip-video` (300 МБ),
     `/:id/video-handoff/upload` (2 ГБ — нужен Telegram-боту, проверить, кто ещё зовёт), lead magnets,
     `socialVideoUpload` одиночный (оставлен для старых вкладок).
   - клиент: все `FormData` + `xhr`/`api()` с видео/файлами (`grep -rn "FormData" apps/web/src`), кто зовёт какие пути.
2. Каждый такой путь клиента перевести на загрузку частями (образец: ролики объектов `upload-sessions`
   в `routes/properties/videos.ts` + `uploadVideoChunked` в `apps/web/src/lib/uploadQueue.ts`, и новый
   `socialVideoUploadSessions.ts`). Общий помощник, а не третья копия: вынести общее ядро сессии частями.
3. Сторож навсегда: в реестр `packages/shared/src/limits.ts` константа «потолок одного запроса через
   прокси» (~90 МБ) и проверка в `scripts/audit-limits.mjs` (шаг precheck/CI): одиночный маршрут с
   `fileSize`/`express.raw limit` выше потолка — красный, если маршрут не в списке исключений с причиной
   (бот Telegram ходит мимо Cloudflare и т.п.). Сторож проверить внесением поломки.
4. Экран: проверка размера ДО отправки по тому же потолку для одиночных путей, понятный текст
   (`apps/web/src/lib/httpStatusMessage.ts` 413 сейчас безликий — сказать «загрузите частями/сожмите»).
5. Соседний класс: таймаут сборки > 100 с → Cloudflare 524 (черновик создаётся, экран видит ошибку).
   Оценить: сборка в фон + опрос статуса.
6. Проверить на сервере (только чтение, с «да» владельца на ssh): `/etc/caddy/Caddyfile` — request_body,
   timeouts read_body; если лимит/таймаут режет — предложить правку владельцу (отдельное «да»).

## Правила
CLAUDE.md репо: своя ветка от свежего origin/main в worktree, `npm run map`, `precheck`, журнал,
черновик PR, `npm run ship` из основной папки (или своего worktree, если основная на чужой ветке).
В D:\CRM чужие незакоммиченные правки — не трогать. Общий node_modules отстал от main
(нет recharts, @testing-library/react, undici): в своём worktree делать `npm ci`, а не ссылки.
