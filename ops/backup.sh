#!/usr/bin/env bash
# Ежедневный бэкап Royal Home CRM: дамп PostgreSQL + архивы томов с файлами
# (фотографии объектов, вложения переписки, сырое видео, документы сделок).
# Запуск на VPS из каталога репозитория (рядом с docker-compose.prod.yml):
#   crontab -e  →  0 3 * * * /opt/royal-home-crm/ops/backup.sh >> /var/log/crm-backup.log 2>&1
#
# Telegram-алерт при сбое использует те же переменные, что и сторож сайта
# (/opt/watchdog.env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) — если файла нет,
# скрипт просто пишет ошибку в лог и выходит с кодом 1 (cron это видно).
set -u -o pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=ops/lib.sh
. "$REPO_DIR/ops/lib.sh"
COMPOSE="docker compose -f $REPO_DIR/docker-compose.prod.yml --env-file $REPO_DIR/.env.production"
# --env-file only affects docker compose's own YAML interpolation, not this
# script's shell — POSTGRES_USER needs to be read here too for the pg_dump -U flag.
POSTGRES_USER="$(grep '^POSTGRES_USER=' "$REPO_DIR/.env.production" | cut -d= -f2-)"
BACKUP_DIR="${CRM_BACKUP_DIR:-/backups/crm}"
# 7 суток, а не 30 (решение владельца 01.10.2026): /backups съедал 22 ГБ из 76 ГБ
# диска VPS, свободного оставалось 12%. Полная история лежит офсайт в R2
# (offsite-backup.sh); локально нужна только свежая копия для быстрого отката.
KEEP_DAYS="${CRM_BACKUP_KEEP_DAYS:-7}"
STAMP="$(date +%F)"
SCRIPT_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

mkdir -p "$BACKUP_DIR"

# report_step <kind> <0|1 успех> <сообщение> [файл] — отчёт в CRM (перенос
# мобильного макета 14.09.2026, шаг 5, экран /backups). ЛУЧШЕЕ УСИЛИЕ: сам
# бэкап уже снят (или уже упал) к моменту вызова — отказ ЭТОГО запроса никогда
# не должен породить второй сбой поверх первого, поэтому `|| true` и пустой
# ключ просто выключают отчёт молча. Строки message контролируются этим же
# скриптом (не вводом извне), поэтому вычищаем кавычки/бэкслеши вместо того
# чтобы тащить JSON-библиотеку в bash.
report_step() {
  [ -z "${BACKUP_REPORT_API_KEY:-}" ] && return 0
  local kind="$1" ok="$2" message="$3" file="${4:-}"
  local size_json="null"
  if [ -n "$file" ] && [ -f "$file" ]; then
    size_json="\"$(du -h "$file" 2>/dev/null | cut -f1 | tr -d '"\\')\""
  fi
  local success_json="false"
  [ "$ok" = "1" ] && success_json="true"
  local detail_json="null"
  [ -n "$message" ] && detail_json="\"$(printf '%s' "$message" | tr -d '"\\')\""
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  REPORT_JSON="{\"kind\":\"$kind\",\"success\":$success_json,\"sizeLabel\":$size_json,\"detail\":$detail_json,\"startedAt\":\"$SCRIPT_STARTED_AT\",\"finishedAt\":\"$now\"}" \
    $COMPOSE exec -T -e REPORT_JSON -e BACKUP_REPORT_API_KEY \
      -e "BACKUP_REPORT_URL=${CRM_BACKUP_REPORT_URL:-http://localhost:4000/api/v1/backups/report}" \
      api node -e '
        fetch(process.env.BACKUP_REPORT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Api-Key": process.env.BACKUP_REPORT_API_KEY },
          body: process.env.REPORT_JSON,
        }).catch(() => {});
      ' >/dev/null 2>&1 || true
}

# Какой шаг сейчас идёт — читает alert() при отказе, чтобы знать, какой kind
# отправить в отчёт, не переписывая сигнатуру alert() в каждом месте вызова.
CURRENT_KIND="DB"

# alert <сообщение> [файлы…] — тревога + удаление ТОЛЬКО перечисленных файлов.
# Раньше alert сносил ВСЕ три архива дня безусловно — и падение позднего шага
# (например, оффсайта) уничтожало уже снятый ВАЛИДНЫЙ дамп базы: при неделе
# недоступного R2 не оставалось ни одного бэкапа вообще (аудит №4, 27.08).
# Удаляется только недописанный артефакт упавшего шага — он по имени неотличим
# от целого; всё, что снялось до него, остаётся.
alert() {
  local message="$1"
  shift
  echo "[backup][ERROR] $message" >&2
  crm_telegram_alert "backup failed: $message" "⚠️"
  report_step "$CURRENT_KIND" 0 "$message"
  [ "$#" -gt 0 ] && rm -f "$@"
  exit 1
}

# АРТЕФАКТ ПИШЕТСЯ ВО ВРЕМЕННЫЙ ФАЙЛ И ПЕРЕИМЕНОВЫВАЕТСЯ ТОЛЬКО ПОСЛЕ УСПЕХА
# (аудит Codex 04.10, OPS03). Редирект `> итоговое-имя` обнуляет уже готовый
# файл дня ДО старта pg_dump/tar, а alert() при отказе удаляет этот самый файл:
# повторный запуск в тот же день (оператор, повтор крона) при недоступной базе
# стирал единственную локальную копию дня. Теперь alert() получает только имя
# временного файла, а прежняя копия остаётся нетронутой до успешной замены.
# Имя начинается с точки: его не заденут ни ротация (crm-*.gz), ни оффсайт
# (--include crm-*-$STAMP.*), если процесс убьют посреди записи.
tmp_of() { printf '%s/.%s.tmp.%s' "$(dirname "$1")" "$(basename "$1")" "$$"; }
publish() { # publish <временный> <итоговый>
  mv -f "$1" "$2" || alert "cannot move $1 into place" "$1"
}

# 0. Ротация ДО записи: если диск заполнен, дамп упадёт и скрипт выйдет — старые
#    архивы так и не удалятся, и следующий запуск упрётся в то же самое. Чистим первыми.
find "$BACKUP_DIR" -name "crm-*.gz" -mtime "+$KEEP_DAYS" -delete
# Недописанные временные файлы убитых запусков (см. tmp_of): запуск моложе суток не трогаем.
find "$BACKUP_DIR" -maxdepth 1 -name '.crm-*.tmp.*' -mmin +1440 -delete

# 1. Дамп базы. pg_dump внутри контейнера, наружу — уже сжатый поток.
CURRENT_KIND="DB"
DB_FILE="$BACKUP_DIR/crm-db-$STAMP.sql.gz"
DB_TMP="$(tmp_of "$DB_FILE")"
$COMPOSE exec -T postgres pg_dump -U "${POSTGRES_USER:-royalhome}" royal_home_crm \
  | gzip > "$DB_TMP" \
  || alert "pg_dump failed" "$DB_TMP"
[ -s "$DB_TMP" ] || alert "db dump is empty" "$DB_TMP"
publish "$DB_TMP" "$DB_FILE"
report_step "DB" 1 "" "$DB_FILE"

# 2. Фотографии объектов (Docker-том uploads_data, смонтирован в api как /app/uploads).
#
#    РАЗ В НЕДЕЛЮ, А НЕ КАЖДУЮ НОЧЬ (владелец, 12.09.2026). Замер в тот день:
#    из 9,2 ГБ копий CRM фотографии занимали 8,7 ГБ, база — 53 МБ за все двадцать
#    ночей. То есть двадцать раз подряд сохранялось почти одно и то же: снимки,
#    добавленные вчера, за ночь не меняются. Ежедневной остаётся база — она и
#    хранит сделки, клиентов и деньги, и стоит копейки.
#
#    Цена решения названа прямо: при смерти диска теряются снимки, добавленные
#    после последней недельной копии. Не сделки, не переписка — только новые
#    фотографии, и те частично остаются опубликованными на сайте.
#
#    Условие — «прошла неделя с прошлой копии», а не «сегодня воскресенье»:
#    пропущенная ночь (сервер был выключен, скрипт упал раньше) сама
#    досоздаст копию следующей ночью, а не будет ждать своего дня недели.
#    Срок хранения общий (KEEP_DAYS), поэтому недельных копий остаётся четыре.
UPLOADS_EVERY_DAYS="${CRM_UPLOADS_BACKUP_EVERY_DAYS:-7}"
uploads_backup_is_due() {
  # -mtime -N — файл изменён МЕНЬШЕ N суток назад. Нашли хоть один свежий —
  # значит копия за эту неделю уже снята, пропускаем шаг.
  local fresh
  fresh="$(find "$BACKUP_DIR" -name "crm-uploads-*.tar.gz" -mtime "-$UPLOADS_EVERY_DAYS" -print -quit 2>/dev/null)"
  [ -z "$fresh" ]
}

CURRENT_KIND="UPLOADS"
if uploads_backup_is_due; then
  UPLOADS_FILE="$BACKUP_DIR/crm-uploads-$STAMP.tar.gz"
  UPLOADS_TMP="$(tmp_of "$UPLOADS_FILE")"
  $COMPOSE exec -T api tar czf - -C /app uploads \
    > "$UPLOADS_TMP" \
    || alert "uploads archive failed" "$UPLOADS_TMP"
  publish "$UPLOADS_TMP" "$UPLOADS_FILE"
  report_step "UPLOADS" 1 "" "$BACKUP_DIR/crm-uploads-$STAMP.tar.gz"
else
  echo "[backup] фотографии объектов: копия свежее $UPLOADS_EVERY_DAYS дней уже есть — пропускаю"
fi

# 3. ПРИВАТНЫЕ вложения переписки — фото и голосовые, присланные клиентами
#    (том private_uploads_data). До 26.08.2026 не бэкапились ВООБЩЕ ни байта:
#    смерть тома означала потерю всего, что клиенты когда-либо присылали.
CURRENT_KIND="PRIVATE_UPLOADS"
PRIVATE_FILE="$BACKUP_DIR/crm-private-uploads-$STAMP.tar.gz"
PRIVATE_TMP="$(tmp_of "$PRIVATE_FILE")"
$COMPOSE exec -T api tar czf - -C /app uploads-private \
  > "$PRIVATE_TMP" \
  || alert "private uploads archive failed" "$PRIVATE_TMP"
publish "$PRIVATE_TMP" "$PRIVATE_FILE"
report_step "PRIVATE_UPLOADS" 1 "" "$BACKUP_DIR/crm-private-uploads-$STAMP.tar.gz"

# 3б. СЫРОЕ ВИДЕО ОБЪЕКТОВ (том property_video_data) — 31.08.2026, замена
#     Cloudflare R2 (тот бэкапился отдельно, средствами самого Cloudflare).
#     Тот же урок, что и с шагом 3 выше: без явного бэкапа смерть тома — потеря
#     всех ещё не смонтированных роликов агентов без возможности восстановить.
#
#     ПРЯМО В R2, МИНУЯ ДИСК (решение владельца 08.10.2026). Архив полный каждую
#     ночь и дорос до 8,6 ГБ; рядом лежали две прежние копии (disk-relief.sh), и
#     в 03:05 свободного места на сервере оставалось меньше гигабайта из 77.
#     Офсайт хранит каждую ночь 180 дней, локальная копия сырых роликов для
#     отката не нужна (restore-drill её не проверяет). Без rclone — по-старому.
CURRENT_KIND="PROPERTY_VIDEO"
VIDEO_FILE="$BACKUP_DIR/crm-property-video-$STAMP.tar.gz"
if command -v rclone >/dev/null 2>&1 && [ "${CRM_BACKUP_VIDEO_LOCAL:-0}" != "1" ]; then
  VIDEO_REMOTE="${CRM_BACKUP_R2_REMOTE:-r2:royalhome-backups}/crm/crm-property-video-$STAMP.tar.gz"
  $COMPOSE exec -T api tar czf - -C /app uploads-private-video \
    | rclone rcat --s3-no-check-bucket --s3-chunk-size 64M "$VIDEO_REMOTE" \
    || alert "property video stream to R2 failed (прежние ночи в R2 целы)"
  report_step "PROPERTY_VIDEO" 1 "$VIDEO_REMOTE"
else
  VIDEO_TMP="$(tmp_of "$VIDEO_FILE")"
  $COMPOSE exec -T api tar czf - -C /app uploads-private-video \
    > "$VIDEO_TMP" \
    || alert "property video archive failed" "$VIDEO_TMP"
  publish "$VIDEO_TMP" "$VIDEO_FILE"
  report_step "PROPERTY_VIDEO" 1 "" "$BACKUP_DIR/crm-property-video-$STAMP.tar.gz"
fi

# 3в. ДОКУМЕНТЫ СДЕЛОК — титул, договор, паспорт, чек выплаты (том
#     deal_docs_data, смонтирован в api как /app/uploads-deal-docs, см.
#     DEAL_DOCS_DIR в docker-compose.prod.yml и lib/dealDocumentFiles.ts).
#     До 02.10.2026 не бэкапились вообще (глубокая проверка, G3): после смерти
#     диска база с записями о документах восстанавливалась, а сами файлы —
#     нет, и «Открыть документ» отдавал бы 404 по всем сделкам. Каждую ночь,
#     как вложения переписки: по объёму документов немного, а потерянный
#     паспорт клиента заново не попросишь. Офсайт (шаг 4) забирает архив тем же
#     шаблоном crm-*-$STAMP.*, отдельной строки там не нужно; проверка, что
#     архив разворачивается, — шаг 9 ops/restore-drill.sh.
CURRENT_KIND="DEAL_DOCS"
DEAL_DOCS_FILE="$BACKUP_DIR/crm-deal-docs-$STAMP.tar.gz"
DEAL_DOCS_TMP="$(tmp_of "$DEAL_DOCS_FILE")"
$COMPOSE exec -T api tar czf - -C /app uploads-deal-docs \
  > "$DEAL_DOCS_TMP" \
  || alert "deal docs archive failed" "$DEAL_DOCS_TMP"
publish "$DEAL_DOCS_TMP" "$DEAL_DOCS_FILE"
report_step "DEAL_DOCS" 1 "" "$BACKUP_DIR/crm-deal-docs-$STAMP.tar.gz"

# 4. ОФФСАЙТ-КОПИЯ В R2 — сразу после снятия, с алертом при сбое.
#    Ремоут "r2" (аккаунт-токен Cloudflare, настроен на VPS с 07.08.2026) — тот же,
#    что использует ночное зеркало /opt/offsite-backup.sh (cron 04:00): оно копирует
#    весь /backups в бакет royalhome-backups, но при сбое пишет только в свой лог и
#    НЕ будит никого. Этот шаг закрывает две дыры: свежий бэкап уезжает оффсайт
#    сразу (а не ждёт до 04:00 — час, в который выкаты и падения самые частые),
#    и сбой оффсайта поднимает Telegram-алерт, как и любой другой шаг.
#    Ротацию оффсайта (180 дней) ведёт /opt/offsite-backup.sh — здесь НЕ удалять,
#    иначе его срок хранения молча схлопнется до локальных KEEP_DAYS.
R2_REMOTE="${CRM_BACKUP_R2_REMOTE:-r2:royalhome-backups}"
# Отказ оффсайта НЕ удаляет ничего: локальные архивы уже сняты и валидны —
# они и есть последний рубеж, когда облако недоступно.
CURRENT_KIND="OFFSITE"
if command -v rclone >/dev/null 2>&1; then
  rclone copy "$BACKUP_DIR" "$R2_REMOTE/crm/" \
    --include "crm-*-$STAMP.*" --max-duration 30m --s3-no-check-bucket \
    || alert "offsite copy to R2 failed (локальные архивы целы)"
  report_step "OFFSITE" 1 "$R2_REMOTE"
else
  alert "rclone is not installed — offsite copy skipped (локальные архивы целы)"
fi

echo "[backup] OK $STAMP: $(du -sh "$BACKUP_DIR" | cut -f1) total in $BACKUP_DIR (offsite: $R2_REMOTE)"
