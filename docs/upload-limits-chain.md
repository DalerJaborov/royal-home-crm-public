# Цепочка лимитов загрузки: Cloudflare → Caddy → nginx → API

Одна страница вместо разбросанных комментариев. Правки лимитов делаются так, чтобы число в каждом
звене было не меньше, чем обещает предыдущее звено клиенту. Сторож — `npm run audit:limits`
(`scripts/audit-limits.mjs`, правила 1-9) и `npm run audit:nginx`.

Откуда числа: `packages/shared/src/uploadLimits.ts` — `UPLOAD_PART_BYTES` (часть, сейчас 8 МБ; сторож
читает её оттуда сам) и `PROXY_SINGLE_REQUEST_MAX_BYTES` (потолок одиночного запроса, 90 МБ).

| Звено | Лимит | Кто задаёт | Что бывает при превышении | Как проверить |
|---|---|---|---|---|
| Cloudflare, размер тела | около 100 МБ (замер 17.11.2026: 95 МБ прошло, 105 МБ — 413 с `Server: cloudflare`). В документации не найдено: страница connection-limits числа не называет. ЦИФРА ДЛЯ ТАРИФА — НЕТ ДАННЫХ (первоисточник не подтверждён) | Cloudflare, тариф | 413 от Cloudflare до нашего сервера | Загрузить файл 95 и 105 МБ через домен; в ответе заголовок `Server: cloudflare` |
| Cloudflare, ожидание ответа | 125 с на чтение ответа от нас, 30 с на запись; отказ — 524 (источник: developers.cloudflare.com/fundamentals/reference/connection-limits/, открыто 25.11.2026; прежняя запись «100 с» в наших заметках по этой странице не подтверждена) | Cloudflare, на бесплатном тарифе не меняется | 524. Поэтому перепаковка/сборка длиннее 125 с обязана отвечать сразу, а не ждать | `curl -i` к медленному маршруту, смотреть 524 |
| Caddy, `request_body max_size` | 95 MiB (потолок одиночного запроса 90 MiB + обёртка multipart; ниже 100 МБ Cloudflare) | `ops/Caddyfile.example`, живой `/etc/caddy/Caddyfile` | 413 HTML-страницей Caddy; с `handle_errors` — JSON `PROXY_413` | `grep max_size /etc/caddy/Caddyfile`; сторож: правило 7 |
| Caddy, `read_body` | 15m: часть 8 МБ на 300 Кбит/с ≈ 224 с ×2 = 448 с; одиночные 95 MiB на 1 Мбит/с ≈ 797 с | то же | Оборванная загрузка: nginx пишет `400 time=… upstream=-`, телефон получает 502 | `grep read_body /etc/caddy/Caddyfile`; `ops/deploy.sh` предупреждает, если живой короче шаблона; сторож: правило 5 |
| Caddy, `read_header` / `write` / `idle` | 5s / 15m / 2m | то же | Медленный заголовок рвётся; скачивание роликов Meta до 15 минут | в том же файле |
| Caddy, ошибки | `handle_errors` → JSON `{"code":"PROXY_NNN","message","error","retryable"}` | то же | без блока — HTML-страница ошибки | сторож: правило 8 |
| nginx `/api/`, общий | `client_max_body_size 150m`, тело БУФЕРИЗУЕТСЯ (tmpfs 128 МБ в mem_limit контейнера), `client_body_timeout 300s`, `proxy_read/send_timeout 130s` | `apps/web/nginx.conf` | 413 / при нескольких крупных телах сразу — падение по памяти и 502 на всю CRM | `docker exec … nginx -T`; сторож: `audit:nginx` |
| nginx, PUT частей (три семейства адресов) | `client_max_body_size 10m`, `proxy_request_buffering off`, `client_body_timeout 120s`, `proxy_read 120s`, `proxy_send 300s` | то же, один `location ~ …/parts/N` | без этого location: 12-14 частей по 8 МБ на слабом канале ≈ 100 МБ в tmpfs, nginx падает, CRM отдаёт 502 | сторож: правило 6 |
| nginx, свободные ролики | `= /api/v1/social-videos`: 2100m без буфера; `…/upload-sessions`: 20m без буфера | то же | 413 (см. расхождения ниже) | `audit:nginx` |
| nginx, ошибки | `@proxy_408/413/502/503/504` — JSON | то же | HTML-страница nginx | сторож: правило 8 |
| API, `express.raw` на частях | 32 МБ (общие сессии, видео объекта, черновик), 16 МБ (свободные ролики) | `apps/api/src/routes/uploadSessions.ts`, `properties/videos.ts`, `properties/drafts.ts`, `socialVideos.ts` | 413 от Express | `audit:limits` правило 3 |
| API, `guardedUpload` (multer) | `maxRequestBytes` ≤ 90 МБ на запрос | `apps/api/src/upload.ts` | 413 `REQUEST_TOO_LARGE` с кодом | `audit:limits` правило 2 |
| API, Node `requestTimeout`/`headersTimeout` | умолчание Node 300 с на всё тело — меньше 448 с, нужных части на 300 Кбит/с с запасом | `apps/api/src/index.ts` (значения ставит волна B) | запрос рвётся посреди части | сторож: правило 9, мягкое: проверяет, только если значение задано явно |

## Расхождения, найденные при проходе 25.11.2026

1. Caddy 25MB против обещания 90 МБ у одиночных маршрутов (import, leadMagnets, videos.ts:732, transcribe): файл 25-90 МБ получал HTML-413 без кода. Выбрана сторона «max_size поднять до 95MiB», а не «снизить потолок»: потолок 90 МБ — публичное обещание экранов, а сам Caddy тело не копит (стримит), риск в нём ниже, чем в nginx.
2. nginx `/api/`: `150m` при буферизации в tmpfs 128 МБ — даже ОДИН буферизуемый запрос больше ~110 МБ упрётся в память, а два по 90 МБ уже вместе не влезают. Сейчас спасает Caddy (95 MiB) и бюджет памяти API (`memoryUploadBudget`). Корень остаётся: одиночные тела до 90 МБ под общим `/api/` буферизуются. Не меняли (риск для остальных маршрутов), нужно решение: либо `proxy_request_buffering off` на `/api/`, либо снизить `client_max_body_size` до ~60m и держать одиночные приёмы ≤ 60 МБ.
3. `= /api/v1/social-videos` в nginx обещает 2100m одним запросом, а Caddy/Cloudflare режут раньше (95 MiB / около 100 МБ). Маршрут жив только пока экран шлёт части. Одиночный путь для больших файлов недостижим — оставлено как есть.
4. Комментарий в nginx «15 фото × 10 МБ» устарел: реально ограничивает Caddy и `memoryUploadBudget` (64 МБ).
5. Умолчание Node `requestTimeout` (300 с) короче 448 с — пока значение не задано явно, сторож его не проверяет (правило 9 мягкое).

## Как применить на проде (НЕ выполнялось; нужно «да» владельца на каждую операцию)

Живой файл в репозитории править нельзя: выкат его не трогает, `ops/deploy.sh` лишь предупреждает.

### 1. Caddy (`/etc/caddy/Caddyfile`)

```bash
ssh rh-vps
cd /opt/royalhome-crm && git log --oneline -1                 # шаблон уже подтянут автовыкатом
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)
# Точечная замена — те же значения, что в ops/Caddyfile.example:
sudo sed -i -E 's/^([[:space:]]*read_body[[:space:]]+)[0-9]+[smh]/\115m/' /etc/caddy/Caddyfile
sudo sed -i -E '0,/max_size 25MB/s//max_size 95MiB/' /etc/caddy/Caddyfile
# Блок handle_errors добавить вручную внутрь `crm.royalhome.tj { … }` по образцу шаблона:
sudo nano /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile   # без ошибок
sudo systemctl reload caddy                                         # reload, не restart
sudo systemctl status caddy --no-pager | head -5
```

Проверка после: `grep -E 'read_body|max_size' /etc/caddy/Caddyfile`; в следующем выкате строка
«ВНИМАНИЕ … короче шаблона» должна исчезнуть. Откат: `sudo cp /etc/caddy/Caddyfile.bak-<метка> /etc/caddy/Caddyfile && sudo systemctl reload caddy`.
Синтаксис `handle_errors` с `{http.error.status_code}` в шаблоне не проверен самим Caddy на этой машине — `caddy validate` на сервере обязателен до reload.

### 2. nginx

Сам выкатывается автовыкатом (образ web собирается из `apps/web/nginx.conf`). Отдельной операции нет;
после выката: `docker exec <web> nginx -t` и проверка, что часть ролика проходит.
