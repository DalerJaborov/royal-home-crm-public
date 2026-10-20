#!/usr/bin/env bash
# Единственный скрипт проверки восстановления копии БД (12→14.09: слит из
# двух параллельных — restore-check.sh и restore-drill.sh, делавших одно и то
# же; оставлено имя restore-drill.sh, потому что оно уже в кроне на сервере).
#
# Раз в неделю проверяет, что последний бэкап РЕАЛЬНО восстанавливается, а не
# просто существует. Поднимает ВРЕМЕННЫЙ контейнер Postgres на отдельном порту,
# накатывает туда последний дамп из ops/backup.sh и проверяет:
#   - число таблиц в схеме public;
#   - count(*) по ключевым таблицам (Client, Property, Deal, Agent, ErrorLog);
#   - что последняя папка миграций репозитория (apps/api/prisma/migrations)
#     применена в _prisma_migrations восстановленной копии;
#   - что самая свежая запись в Client не старше суток;
#   - count(*) по Client и Deal в пределах ±TOLERANCE_PCT% от прода (сравнение
#     с боевым compose-стеком, если он на этом хосте поднят);
#   - что последний архив документов сделок (crm-deal-docs-*.tar.gz из
#     ops/backup.sh, шаг 3в) не старше 30 часов и РАЗВОРАЧИВАЕТСЯ в
#     uploads-deal-docs — без этого восстановленная база ссылалась бы на
#     паспорта и договоры, которых нет (глубокая проверка 02.10.2026, G3).
# Итог — Telegram-алерт через общую ops/lib.sh (тот же /opt/watchdog.env, что
# у backup.sh и disk-watch.sh).
#
# ИДЕМПОТЕНТЕН: временный контейнер и том всегда пересоздаются с нуля и
# удаляются в конце (trap), повторный запуск не копит мусор.
#
# Cron (раз в неделю, ночью — не мешает боевой базе диском/CPU):
#   0 4 * * 0 /opt/royalhome-crm/ops/restore-drill.sh >> /var/log/crm-restore-drill.log 2>&1
#
# Второй режим — восстановление В ПРОД (используется только из bootstrap.sh с
# явным флагом, при подъёме сервера с нуля):
#   ops/restore-drill.sh --into-prod <файл.sql.gz>
# В этом режиме проверки на временном контейнере не запускаются — копия льётся
# прямо в сервис postgres из docker-compose.prod.yml, который ДОЛЖЕН уже быть
# поднят (bootstrap поднимает его перед вызовом). Требует явного подтверждения
# (переменной окружения CONFIRM=yes или интерактивного ввода "yes"). Копия —
# обычный SQL без DROP, поэтому в непустую базу скрипт её не катит (OPS02, аудит
# 04.10): нужен явный CRM_RESTORE_WIPE=yes, тогда схема public сносится и
# пересоздаётся в той же транзакции, что и накат. Любая ошибка SQL — провал.
set -u -o pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=ops/lib.sh
. "$REPO_DIR/ops/lib.sh"

BACKUP_DIR="${CRM_BACKUP_DIR:-/backups/crm}"
DRILL_CONTAINER="crm-restore-drill-pg"
DRILL_PORT="${CRM_RESTORE_DRILL_PORT:-55432}"
DRILL_DB="royal_home_crm_drill"
DRILL_PASSWORD="drillpass"
TOLERANCE_PCT="${CRM_RESTORE_DRILL_TOLERANCE:-5}"
MAX_CLIENT_AGE_HOURS="${CRM_RESTORE_DRILL_MAX_AGE_H:-24}"
EXPECTED_MIN_TABLES=20

COMPOSE="docker compose -f $REPO_DIR/docker-compose.prod.yml --env-file $REPO_DIR/.env.production"
PROD_POSTGRES_USER="$(grep '^POSTGRES_USER=' "$REPO_DIR/.env.production" 2>/dev/null | cut -d= -f2-)"
PROD_POSTGRES_USER="${PROD_POSTGRES_USER:-royalhome}"
# Роль временной базы ОБЯЗАНА совпадать с владельцем объектов в дампе (pg_dump без
# --no-owner пишет ALTER ... OWNER TO <роль прода>): с чужой ролью каждая такая
# строка — «role does not exist», а теперь, когда накат строгий (ON_ERROR_STOP),
# это был бы провал каждого еженедельного прогона (аудит Codex 04.10, OPS02).
DRILL_USER="${CRM_RESTORE_DRILL_USER:-$PROD_POSTGRES_USER}"

log() { echo "[restore-drill] $*"; }

# Обычная проверка — режим "drill", не трогает прод; --into-prod ставится
# ниже, до отчёта в CRM это не должно доходить под чужим именем (перенос
# мобильного макета 14.09.2026, шаг 5, экран /backups).
MODE="drill"

# report_step — тот же приём, что в ops/backup.sh (см. его комментарий):
# лучшее усилие, отказ отчёта никогда не роняет сам скрипт.
report_step() {
  [ -z "${BACKUP_REPORT_API_KEY:-}" ] && return 0
  local kind="$1" ok="$2" message="$3"
  local success_json="false"
  [ "$ok" = "1" ] && success_json="true"
  local detail_json="null"
  [ -n "$message" ] && detail_json="\"$(printf '%s' "$message" | tr -d '"\\')\""
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  REPORT_JSON="{\"kind\":\"$kind\",\"success\":$success_json,\"sizeLabel\":null,\"detail\":$detail_json,\"startedAt\":\"$now\",\"finishedAt\":\"$now\"}" \
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

alert() { # alert <текст> [1 при успехе]
  local message="$1" ok="${2:-0}"
  local prefix="⚠️"
  [ "$ok" = "1" ] && prefix="✅"
  log "$message"
  crm_telegram_alert "restore-drill: $message" "$prefix"
  [ "$MODE" = "drill" ] && report_step "RESTORE_DRILL" "$ok" "$message"
}

fail() {
  local message="$1"
  echo "[restore-drill][ERROR] $message" >&2
  alert "$message"
  exit 1
}

DEAL_DOCS_TMP=""

cleanup() {
  # -v: без него анонимный том данных Postgres переживает контейнер и остаётся
  # мусором навсегда (18.09: 283 таких тома съели диск VPS почти до отказа).
  docker rm -f -v "$DRILL_CONTAINER" >/dev/null 2>&1 || true
  # Распакованные документы сделок (шаг 9) — паспорта клиентов, не оставлять.
  if [ -n "$DEAL_DOCS_TMP" ]; then rm -rf "$DEAL_DOCS_TMP"; fi
}
trap cleanup EXIT INT TERM

find_latest_backup() {
  find "$BACKUP_DIR" -maxdepth 1 -name 'crm-db-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-
}

# ── режим "--into-prod": восстановление в рабочий compose-стек ─────────────
if [ "${1:-}" = "--into-prod" ]; then
  MODE="into-prod"
  FILE="${2:-}"
  [ -n "$FILE" ] && [ -f "$FILE" ] || { echo "Использование: $0 --into-prod <файл.sql.gz>" >&2; exit 2; }
  echo "[restore-drill] ВНИМАНИЕ: восстановление ПОВЕРХ прод-базы royal_home_crm из $FILE" >&2
  echo "[restore-drill] копия — обычный SQL без DROP: в базу с таблицами она не накатывается." >&2
  echo "[restore-drill] непустую базу скрипт отвергнет, пока не задан CRM_RESTORE_WIPE=yes (тогда схема public будет снесена и пересоздана — НЕОБРАТИМО)." >&2
  if [ "${CONFIRM:-}" != "yes" ]; then
    read -r -p "Введи 'yes' для подтверждения: " ANSWER
    [ "$ANSWER" = "yes" ] || { echo "[restore-drill] отменено пользователем" >&2; exit 2; }
  fi
  $COMPOSE exec -T postgres pg_isready -U "$PROD_POSTGRES_USER" >/dev/null 2>&1 \
    || fail "сервис postgres прод-compose не отвечает — сначала подними его"
  # Аудит Codex 04.10, OPS02. Раньше psql шёл без ON_ERROR_STOP: SQL-ошибки
  # (already exists, duplicate key) он печатал, ПРОДОЛЖАЛ файл и выходил с кодом
  # 0 — скрипт рапортовал «выполнено», bootstrap катил deploy поверх наполовину
  # накатанной базы. Теперь любая ошибка обрывает накат, а --single-transaction
  # откатывает всё сделанное: база остаётся как была, а не в полусостоянии.
  TABLES_NOW="$($COMPOSE exec -T postgres psql -U "$PROD_POSTGRES_USER" -d royal_home_crm -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null | tr -d '[:space:]')"
  case "$TABLES_NOW" in
    ''|*[!0-9]*) fail "не смог проверить, пуста ли прод-база (ответ: '${TABLES_NOW}') — накатку не начинаю" ;;
  esac
  RESTORE_PREFIX=""
  if [ "$TABLES_NOW" -gt 0 ]; then
    [ "${CRM_RESTORE_WIPE:-}" = "yes" ] \
      || fail "в прод-базе уже $TABLES_NOW таблиц, а копия — обычный SQL без DROP. Накатка поверх даст already exists и полусостояние. Если базу надо заменить целиком, повтори с CRM_RESTORE_WIPE=yes (схема public будет снесена и пересоздана в той же транзакции, при ошибке всё откатится)."
    RESTORE_PREFIX='DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
  fi
  { [ -z "$RESTORE_PREFIX" ] || printf '%s\n' "$RESTORE_PREFIX"; gunzip -c "$FILE"; } \
    | $COMPOSE exec -T postgres psql -v ON_ERROR_STOP=1 --single-transaction -U "$PROD_POSTGRES_USER" -d royal_home_crm \
    || fail "восстановление в прод-базу не удалось (изменения откачены)"
  echo "[restore-drill] восстановление в прод-базу выполнено из $FILE"
  exit 0
fi

# ── обычный режим: проверка без касания рабочей базы ────────────────────────

# 1. Найти последний дамп базы.
LATEST_DUMP="$(find_latest_backup)"
[ -n "$LATEST_DUMP" ] && [ -f "$LATEST_DUMP" ] || fail "в $BACKUP_DIR нет ни одного crm-db-*.sql.gz"

DUMP_AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$LATEST_DUMP" 2>/dev/null || stat -f %m "$LATEST_DUMP") ) / 3600 ))
if [ "$DUMP_AGE_H" -gt 30 ]; then
  fail "последний дамп $LATEST_DUMP старше 30 часов ($DUMP_AGE_H ч) — бэкап не обновлялся"
fi
log "дамп: $LATEST_DUMP (возраст ${DUMP_AGE_H}ч)"

# 2. Поднять временный Postgres.
cleanup
docker run -d --name "$DRILL_CONTAINER" \
  -e POSTGRES_USER="$DRILL_USER" -e POSTGRES_PASSWORD="$DRILL_PASSWORD" -e POSTGRES_DB="$DRILL_DB" \
  -p "127.0.0.1:${DRILL_PORT}:5432" \
  postgres:16-alpine >/dev/null \
  || fail "не удалось поднять временный контейнер"

log "ждём готовности временной базы"
READY=0
for _ in $(seq 30); do
  if docker exec "$DRILL_CONTAINER" pg_isready -U "$DRILL_USER" -d "$DRILL_DB" >/dev/null 2>&1; then READY=1; break; fi
  sleep 2
done
[ "$READY" = "1" ] || fail "временный postgres не поднялся за 60с"

# 3. Накатить дамп.
# Строго (аудит Codex 04.10, OPS02): без ON_ERROR_STOP psql на SQL-ошибке идёт дальше
# и выходит с 0, и проверки ниже (число таблиц, пять таблиц, последняя миграция)
# не видели бы потерянных остальных таблиц. Строка ^ERROR в логе — провал и сама
# по себе, на случай если код возврата снова окажется нулевым.
if ! gunzip -c "$LATEST_DUMP" | docker exec -i "$DRILL_CONTAINER" psql -v ON_ERROR_STOP=1 --single-transaction -U "$DRILL_USER" -d "$DRILL_DB" >/tmp/crm-restore-drill.log 2>&1 \
  || grep -q '^ERROR' /tmp/crm-restore-drill.log; then
  tail -20 /tmp/crm-restore-drill.log >&2
  fail "восстановление дампа упало — см. /tmp/crm-restore-drill.log на сервере"
fi
log "дамп накачен"

psql_q() { # psql_q <sql> — одно значение из временной базы
  docker exec "$DRILL_CONTAINER" psql -U "$DRILL_USER" -d "$DRILL_DB" -tAc "$1" 2>/dev/null | tr -d '[:space:]'
}

FAILED=0
CHECKS=""

# 4. Число таблиц в схеме public.
TABLE_COUNT="$(psql_q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
if [ -n "$TABLE_COUNT" ] && [ "$TABLE_COUNT" -ge "$EXPECTED_MIN_TABLES" ] 2>/dev/null; then
  log "таблицы (schema public): OK ($TABLE_COUNT)"
else
  CHECKS="${CHECKS}таблицы public=${TABLE_COUNT:-0} (ожидали >= $EXPECTED_MIN_TABLES); "
  FAILED=1
fi

# 5. Ключевые таблицы читаются.
for tbl in Client Property Deal Agent ErrorLog; do
  cnt="$(psql_q "SELECT count(*) FROM \"$tbl\"")"
  if [ -n "$cnt" ] && [ "$cnt" -ge 0 ] 2>/dev/null; then
    log "таблица $tbl: OK ($cnt строк)"
  else
    CHECKS="${CHECKS}таблица $tbl не читается; "
    FAILED=1
  fi
done

# 6. Последняя миграция репозитория применена.
LATEST_MIGRATION_DIR="$(find "$REPO_DIR/apps/api/prisma/migrations" -maxdepth 1 -mindepth 1 -type d -printf '%f\n' 2>/dev/null | sort | tail -1)"
if [ -n "$LATEST_MIGRATION_DIR" ]; then
  APPLIED="$(psql_q "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$LATEST_MIGRATION_DIR' AND finished_at IS NOT NULL")"
  if [ "${APPLIED:-0}" -ge 1 ] 2>/dev/null; then
    log "последняя миграция ($LATEST_MIGRATION_DIR): OK"
  else
    CHECKS="${CHECKS}миграция $LATEST_MIGRATION_DIR не в _prisma_migrations; "
    FAILED=1
  fi
else
  log "последняя миграция: пропущено (папка миграций не найдена)"
fi

# 7. Свежесть Client.createdAt.
NEWEST_CLIENT_AGE_H="$(psql_q "SELECT COALESCE(ROUND(EXTRACT(EPOCH FROM (now() - max(\"createdAt\")))/3600), 999999) FROM \"Client\"")"
if [ -n "$NEWEST_CLIENT_AGE_H" ] && [ "${NEWEST_CLIENT_AGE_H%.*}" -le "$MAX_CLIENT_AGE_HOURS" ] 2>/dev/null; then
  log "свежесть Client.createdAt: OK (${NEWEST_CLIENT_AGE_H}ч назад)"
else
  CHECKS="${CHECKS}Client.createdAt ${NEWEST_CLIENT_AGE_H:-?}ч назад (порог ${MAX_CLIENT_AGE_HOURS}ч); "
  FAILED=1
fi

# 8. Сравнение Client/Deal с продом (±TOLERANCE_PCT%), если прод доступен на этом хосте.
DRILL_CLIENTS="$(psql_q "SELECT count(*) FROM \"Client\"")"
DRILL_DEALS="$(psql_q "SELECT count(*) FROM \"Deal\"")"
if [ -f "$REPO_DIR/.env.production" ] && $COMPOSE exec -T postgres pg_isready -U "$PROD_POSTGRES_USER" >/dev/null 2>&1; then
  PROD_CLIENTS="$($COMPOSE exec -T postgres psql -U "$PROD_POSTGRES_USER" -d royal_home_crm -tAc 'SELECT count(*) FROM "Client"' 2>/dev/null || echo 0)"
  PROD_DEALS="$($COMPOSE exec -T postgres psql -U "$PROD_POSTGRES_USER" -d royal_home_crm -tAc 'SELECT count(*) FROM "Deal"' 2>/dev/null || echo 0)"

  within_tolerance() { # within_tolerance <drill> <prod>
    local drill="$1" prod="$2"
    [ "$prod" -eq 0 ] && { [ "$drill" -eq 0 ]; return $?; }
    local diff=$(( drill > prod ? drill - prod : prod - drill ))
    local limit=$(( prod * TOLERANCE_PCT / 100 ))
    [ "$diff" -le "$limit" ]
  }

  log "Client: дамп=$DRILL_CLIENTS прод=$PROD_CLIENTS; Deal: дамп=$DRILL_DEALS прод=$PROD_DEALS"
  within_tolerance "$DRILL_CLIENTS" "$PROD_CLIENTS" || { CHECKS="${CHECKS}Client дамп=$DRILL_CLIENTS прод=$PROD_CLIENTS (> ${TOLERANCE_PCT}%); "; FAILED=1; }
  within_tolerance "$DRILL_DEALS" "$PROD_DEALS" || { CHECKS="${CHECKS}Deal дамп=$DRILL_DEALS прод=$PROD_DEALS (> ${TOLERANCE_PCT}%); "; FAILED=1; }
else
  log "сравнение с продом пропущено (прод-compose недоступен на этом хосте)"
fi

# 9. Архив документов сделок (G3, 02.10.2026) разворачивается. Строки
#    DealDocument из дампа без самих файлов бесполезны: «Открыть документ»
#    отдал бы 404 по всем сделкам. Распаковываем во временную папку целиком —
#    по объёму документов немного — и считаем файлы.
LATEST_DEAL_DOCS="$(find "$BACKUP_DIR" -maxdepth 1 -name 'crm-deal-docs-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | head -1 | cut -d' ' -f2-)"
DEAL_DOCS_FILES="?"
if [ -z "$LATEST_DEAL_DOCS" ] || [ ! -f "$LATEST_DEAL_DOCS" ]; then
  CHECKS="${CHECKS}в $BACKUP_DIR нет ни одного crm-deal-docs-*.tar.gz (документы сделок не в копии); "
  FAILED=1
else
  DEAL_DOCS_AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$LATEST_DEAL_DOCS" 2>/dev/null || stat -f %m "$LATEST_DEAL_DOCS") ) / 3600 ))
  DEAL_DOCS_TMP="$(mktemp -d)"
  if tar xzf "$LATEST_DEAL_DOCS" -C "$DEAL_DOCS_TMP" 2>/dev/null && [ -d "$DEAL_DOCS_TMP/uploads-deal-docs" ]; then
    DEAL_DOCS_FILES="$(find "$DEAL_DOCS_TMP/uploads-deal-docs" -type f | wc -l | tr -d '[:space:]')"
    if [ "$DEAL_DOCS_AGE_H" -gt 30 ]; then
      CHECKS="${CHECKS}архив документов сделок $LATEST_DEAL_DOCS старше 30 часов ($DEAL_DOCS_AGE_H ч); "
      FAILED=1
    else
      log "документы сделок: OK ($DEAL_DOCS_FILES файлов, $LATEST_DEAL_DOCS)"
    fi
  else
    CHECKS="${CHECKS}архив документов сделок $LATEST_DEAL_DOCS не разворачивается; "
    FAILED=1
  fi
  rm -rf "$DEAL_DOCS_TMP"
  DEAL_DOCS_TMP=""
fi

if [ "$FAILED" -ne 0 ]; then
  fail "копия $LATEST_DUMP не прошла проверку: ${CHECKS}"
fi

alert "дамп $LATEST_DUMP восстановлен и проверен (таблиц=$TABLE_COUNT, Client=$DRILL_CLIENTS, Deal=$DRILL_DEALS, документов сделок=$DEAL_DOCS_FILES)" 1
log "OK"
