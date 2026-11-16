# 16.11.2026 — большой ролик рвался при отдаче Meta (Instagram выложил ~10 с)

## Что было
Ролик №197 (~1:59, 236,8 МБ, 60 к/с) 14.11 кнопкой «выпустить сразу»: Facebook отказал
«Unable to fetch video file from URL», Instagram опубликовал обрезок ~10 с. Тот же класс —
№193 06.11 (143 МБ). Meta (IG Reels `video_url`, FB `file_url`, Threads) забирает ролик
по ссылке `crm.royalhome.tj/uploads/…` (`publicUploadUrl`), то есть через nginx контейнера web.
В журнале Caddy оба запроса Meta оборвались `reading: unexpected EOF` от `127.0.0.1:8080` через ~3 с.

## Причина (ФАКТ, воспроизведено на стенде)
`location /uploads/` в `apps/web/nginx.conf` проксировал к API с буферизацией по умолчанию.
nginx читает API быстрее, чем клиент скачивает, и кладёт остаток во временный файл
`/var/cache/nginx/proxy_temp` — это tmpfs, который считается в `mem_limit: 128m` контейнера
web. Ролик больше ~110 МБ не помещается: ядро убивает nginx по памяти, соединение рвётся.

## Стенд (Docker, web = nginx:1.27-alpine с конфигом репо, read_only, tmpfs и mem_limit 128m
как в docker-compose.prod.yml, api — отдаёт файл 248 300 000 байт, `curl --limit-rate 5M`)
- ДО:    `http=200 downloaded=10798733 of 248300000` — curl (18), в логе nginx
  «upstream response is buffered to a temporary file», `OOMKilled=true`.
- ПОСЛЕ: `http=200 downloaded=248300000 of 248300000, time=77s`, `OOMKilled=false`,
  память web 10,8 МБ, временных файлов 0.

## Правка
- `apps/web/nginx.conf`, `location /uploads/`: `proxy_buffering off`, `proxy_max_temp_file_size 0`,
  `proxy_read_timeout 600s`, `proxy_send_timeout 600s`. Остальные пути с видео (`/api/…`, в т.ч.
  публичный ролик объекта `publicFeed`, загрузка свободных роликов) уже были без буферизации.
  Все соседи по механизму (FB `file_url`, Threads, свободные ролики, перевыкладка после смены
  озвучки, публикация по расписанию, повтор после частичного отказа, сайт royalhome.tj через
  `/uploads/*`) идут через этот же location — правка одна на всех.
- Сторож `scripts/audit-nginx-conf.mjs` (`audit:nginx` в precheck): любой `location` с `proxy_pass`
  без `proxy_buffering off` или `proxy_max_temp_file_size 0` — красный. Проверен на старом
  конфиге: красный на `location /uploads/` (строка 159), на новом — зелёный.

## Не сделано / следующий шаг
- Пережатие тяжёлых роликов (>~100 МБ или 60 к/с → 30 к/с ~8 Мбит/с) перед отдачей сетям.
  Общая точка есть одна — `publishApprovedPost` в `apps/api/src/lib/socialPublish.ts`
  (`const videoUrl = publicUploadUrl(params.localVideoPath)`), но истории идут отдельно через
  `instagramStories.ts`, а пережатие 2-минутного ролика — минуты CPU на проде, временные файлы
  и их уборка. Корень бага закрыт nginx, поэтому пережатие — отдельной правкой.
- Caddy на сервере: `timeouts.write 200s` — медленное скачивание файла дольше 200 с оборвёт
  уже Caddy. Это живой конфиг прода вне репозитория — менять только с «да» владельца.
- После выката: перевыпустить №197 в Instagram/Facebook (старый обрезок удалить вручную).
