# 17.11.2026 — класс «большой файл одним запросом → 413 от прокси» закрыт целиком

**Что было.** Ролик 87 МБ в «Роликах в соцсети» получал 413 ещё до API: Cloudflare режет тело
больше 100 МБ, nginx контейнера web буферизует тело в tmpfs 128 МБ, а приложение обещало
принять одним запросом 300 МБ (переписка, ролик карточки), 700 МБ × 5 (видео объекта) и 2 ГБ
(готовый ролик монтажёра, свободный ролик). Свободные ролики уже переведены на части
(`2026-11-17-social-video-chunked-upload.md`); эта правка — весь остальной класс и сторож.

**Найденные места (сервер → кто зовёт → что сделано).**
- `POST /properties/:id/clip-video`, 300 МБ — экран: `uploadQueue.sendClipTask` и
  `PropertyClipVideoCard` одним запросом. → Экран шлёт **частями**: общие сессии
  `POST /api/v1/upload-sessions` (назначение `clip-video`) + сборка
  `POST /properties/:id/clip-video/upload-sessions/:id/complete` (та же `acceptClipVideoFile`).
  Одиночный приём оставлен для старых вкладок, предел — 90 МБ.
- `POST /conversations/:id/reply-media`, 300 МБ — экран: `lib/mediaUpload.ts` одним запросом.
  → **Частями** (назначение `conversation-media`), сборка
  `POST /conversations/:id/reply-media/upload-sessions/complete` с `sessionId` в теле: ключ
  повтора (`Idempotency-Key`) привязан к адресу, и с id в адресе «Повторить» получил бы 422.
  Доставка — та же `deliverReplyMedia`. Попутно: экран обещал 1 ГБ, сервер принимал 300 МБ —
  теперь одно число `CONVERSATION_MEDIA_MAX_BYTES` в shared; одиночный маршрут больше не
  оставляет временный файл, если диалог не найден.
- `POST /properties/:id/video-handoff/upload`, 2 ГБ — вызывающих в репозитории нет (экран идёт
  сессиями `purpose=handoff`; «Telegram-бот шлёт сюда» не подтвердилось — бот принимает ролик
  функцией). → Предел 90 МБ.
- `POST /properties/:id/videos`, 700 МБ × 5 в память — вызывающих нет (экран идёт сессиями).
  → Предел 90 МБ на запрос.
- `POST /social-videos` (одиночный, 2 ГБ) — старые вкладки. → 90 МБ.
- Фото: `POST /properties/:id/photos` (30 × 30 МБ), черновик (5 × 30), фото-пост соцсетей
  (10 × 20) — экран режет пачки по 8 МБ / шлёт по одному, но одиночный несжатый снимок или
  десять тяжёлых фото поста могли перевалить потолок. → Проверка веса до отправки
  (`assertFitsSingleRequest`) и предел запроса 90 МБ у двери.
- Остальные (аватар, логотип, документы сделки, звук, PDF лид-магнита, CSV, диктовка) — до 30 МБ,
  переведены на дверь без изменения пределов файла.
- `express.raw`: части 32/16 МБ — ниже потолка.

**Одна дверь.** `upload.ts::guardedUpload({ name, maxRequestBytes, overProxyCeilingReason? })` —
единственное место, где создаётся multer; заодно отвечает 413 с понятным текстом по заявленному
весу запроса, не читая тело. Ядро сессий частями — `lib/chunkedUploadSessions.ts` (свободные
ролики стали тонкой обёрткой над ним), общий маршрут старта и частей — `routes/uploadSessions.ts`,
помощник экрана — `apps/web/src/lib/chunkedUpload.ts` (`uploadInParts`, `uploadToPurpose`).
Потолок и пределы назначений — `packages/shared/src/uploadLimits.ts`
(`PROXY_SINGLE_REQUEST_MAX_BYTES`, `CHUNKED_UPLOAD_PURPOSES`).

**Сторож.** `npm run audit:limits` (`scripts/audit-limits.mjs`, шаг precheck → CI): `multer(` вне
двери, `maxRequestBytes` выше 90 МБ без причины, `express.raw/json` с пределом выше потолка,
FormData через XMLHttpRequest без `assertFitsSingleRequest` — красный. Проверен поломкой: четыре
внесённых нарушения дали четыре красные строки и код 1, исключение с причиной печатается.

**Экран.** 413 — «Сожмите его или разделите на несколько файлов»; 524 (Cloudflare не дождался
100 с) — «работа могла завершиться, проверьте, прежде чем повторять». `api()` отказывает до
отправки, если файлы формы тяжелее потолка.

**Чем проверено.** См. отчёт PR: `tests/upload-size-class.test.ts` (API), 
`src/lib/__tests__/uploadSizeClass.test.ts` (web), `scripts/audit-limits.test.mjs`, precheck.

**Осталось.** Сборка дольше 100 с (свободный ролик: перепаковка до 5 минут) по-прежнему даёт 524
от Cloudflare при созданном черновике — нужна сборка в фоне с опросом статуса. Caddy на хосте:
лимит тела и таймауты не проверены (нужно «да» на ssh, только чтение).
