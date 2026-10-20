#!/usr/bin/env bash
# Сторож, который БУДИТ зависший сервер (аудит 23.09.2026, круг 3, №77; просьба
# Dan 25.09: «внешний сторож, который будит сервер, если он завис»).
#
# Ставится в cron раз в минуту (ops/install-health-watch.sh):
#   * * * * * /opt/royalhome-crm/ops/health-watch.sh >> /var/log/crm-health-watch.log 2>&1
#
# Зачем, если есть disk-watch.sh: тот только ПИШЕТ в Telegram, раз в 15 минут, и
# смотрит на обычный /health, который отвечает «жив» и при зависшем фоновом
# процессе. Docker сам «нездоровый» контейнер не перезапускает (restart:
# unless-stopped срабатывает только на выход процесса), а сторож пульса тиков
# живёт внутри worker и молчит вместе с ним. Этот скрипт смотрит на
# /api/v1/health/deep (apps/api/src/lib/deepHealth.ts) и перезапускает:
#   - api — если адрес не ответил (таймаут, 502/504) CRM_HEALTH_FAILS проверок
#     подряд, а сам контейнер api Docker считает нездоровым. Если api здоров, а
#     снаружи ответа нет — виноват web (nginx), перезапускается он;
#   - worker — если база отвечает, а пульс тиков молчит дольше 10 минут
#     CRM_HEALTH_FAILS проверок подряд.
# База (postgres) НЕ перезапускается: это только алерт — перезапуск базы на
# ходу опаснее, чем минута её молчания, и решается человеком.
#
# Не мешает выкату: пока выкат держит /var/lock/royalhome-deploy.lock, проверка
# пропускается и счётчики сбрасываются (контейнеры в это время пересоздаются, и
# «не отвечает» — норма). После перезапуска CRM_HEALTH_COOLDOWN_MIN минут
# повторно тот же контейнер не трогается: если не помогло — один алерт
# «перезапуск не помог», а не перезапуск каждую минуту.
#
# Алерты — тот же Telegram, что у бэкапов и disk-watch (/opt/watchdog.env).
set -u

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=ops/lib.sh
. "$REPO_DIR/ops/lib.sh"

BASE="${CRM_HEALTH_BASE:-http://127.0.0.1:8080/api/v1}"
STATE_DIR="${CRM_HEALTH_STATE_DIR:-/var/lib/royalhome-health-watch}"
FAILS_TO_RESTART="${CRM_HEALTH_FAILS:-3}"
COOLDOWN_MIN="${CRM_HEALTH_COOLDOWN_MIN:-15}"
# Сразу после перезапуска или выката контейнер ещё поднимается (миграции, первый
# тик расписания — до пары минут), и пульс в это время законно старый.
GRACE_MIN="${CRM_HEALTH_GRACE_MIN:-5}"
DEPLOYED_SHA_FILE="${CRM_DEPLOYED_SHA_FILE:-/var/lib/royalhome-auto-deploy/deployed-sha}"
DEPLOY_LOCK="${CRM_DEPLOY_LOCK:-/var/lock/royalhome-deploy.lock}"
API_CONTAINER="${CRM_API_CONTAINER:-royalhome-crm-api-1}"
WORKER_CONTAINER="${CRM_WORKER_CONTAINER:-royalhome-crm-worker-1}"
WEB_CONTAINER="${CRM_WEB_CONTAINER:-royalhome-crm-web-1}"

mkdir -p "$STATE_DIR" || { echo "[health-watch] нет доступа к $STATE_DIR" >&2; exit 1; }

# Перезапуск идёт до 90 с, а cron зовёт каждую минуту — второй экземпляр не нужен.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$STATE_DIR/.run.lock"
  flock -n 9 || exit 0
fi

say() { echo "[health-watch] $(date -u +%FT%TZ) $*"; }

fails() { cat "$STATE_DIR/$1.fails" 2>/dev/null || echo 0; }
bump() { local n; n="$(fails "$1")"; echo $((n + 1)) > "$STATE_DIR/$1.fails"; echo $((n + 1)); }
reset() { rm -f "$STATE_DIR/$1.fails" "$STATE_DIR/$1.gaveup"; }

fresher_than() { # fresher_than <файл> <минут>
  [ -f "$1" ] && [ -n "$(find "$1" -mmin "-$2" 2>/dev/null)" ]
}
recently_restarted() { fresher_than "$STATE_DIR/$1.restarted" "$COOLDOWN_MIN"; }

# Алерт один раз, пока беда не пройдёт (штамп снимает reset).
alert_once() { # alert_once <ключ> <текст>
  local f="$STATE_DIR/$1.gaveup"
  [ -f "$f" ] && return 0
  crm_telegram_alert "health-watch: $2" "🔴" && touch "$f"
}

restart() { # restart <ключ> <контейнер> <причина>
  local key="$1" container="$2" reason="$3"
  if recently_restarted "$key"; then
    say "$container уже перезапускали за последние $COOLDOWN_MIN мин — не помогло: $reason"
    alert_once "$key" "$container перезапущен, но не ожил: $reason. Нужен человек: journalctl и docker logs $container"
    return 0
  fi
  say "перезапускаю $container: $reason"
  if docker restart --time 90 "$container" >/dev/null 2>&1; then
    touch "$STATE_DIR/$key.restarted"
    rm -f "$STATE_DIR/$key.fails"
    crm_telegram_alert "health-watch: $container завис и перезапущен ($reason)" "🔁" || true
  else
    alert_once "$key" "не удалось перезапустить $container ($reason)"
  fi
}

# 0. Идёт выкат — контейнеры пересоздаются, «не отвечает» сейчас норма.
if command -v flock >/dev/null 2>&1 && [ -e "$DEPLOY_LOCK" ]; then
  if ! flock -n "$DEPLOY_LOCK" true; then
    say "идёт выкат — пропускаю проверку"
    rm -f "$STATE_DIR"/*.fails
    touch "$STATE_DIR/deploy.seen"
    exit 0
  fi
fi

# Выкат только что закончился (отметку ведут оба пути выката) или сторож сам
# недавно перезапускал контейнер — даём подняться, счётчики не копим.
if fresher_than "$DEPLOYED_SHA_FILE" "$GRACE_MIN" || fresher_than "$STATE_DIR/deploy.seen" "$GRACE_MIN"; then
  say "выкат был меньше $GRACE_MIN мин назад — даю контейнерам подняться"
  rm -f "$STATE_DIR"/*.fails
  exit 0
fi
in_grace() { fresher_than "$STATE_DIR/$1.restarted" "$GRACE_MIN"; }

# 1. Глубокая проверка через nginx, как ходят пользователи.
RESPONSE="$(curl -s --max-time 20 -w '\n%{http_code}' "$BASE/health/deep" 2>/dev/null)" || true
CODE="$(printf '%s' "$RESPONSE" | tail -n 1)"
BODY="$(printf '%s' "$RESPONSE" | sed '$d')"
case "$CODE" in ''|*[!0-9]*) CODE=000 ;; esac

# Старая версия API без глубокой проверки — судим по обычной.
if [ "$CODE" = "404" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/health" 2>/dev/null)" || CODE=000
  [ "$CODE" = "200" ] && BODY='{"ok":true,"db":true,"worker":true}'
fi

if [ "$CODE" = "200" ]; then
  reset api; reset web; reset worker; reset db
  exit 0
fi

# 2. Ответ пришёл, но не 200: API жив, смотрим, что именно не так.
if [ "$CODE" = "503" ] && printf '%s' "$BODY" | grep -q '"db"'; then
  reset api
  if printf '%s' "$BODY" | grep -q '"db":false'; then
    n="$(bump db)"
    say "база не отвечает ($n подряд)"
    [ "$n" -ge "$FAILS_TO_RESTART" ] && alert_once db "база не отвечает $n мин подряд — перезапускать её сторож не будет, нужен человек"
    exit 0
  fi
  reset db
  if printf '%s' "$BODY" | grep -q '"worker":false'; then
    if in_grace worker; then say "worker недавно перезапущен — жду первый тик"; exit 0; fi
    n="$(bump worker)"
    say "фоновый процесс молчит ($n подряд): $BODY"
    [ "$n" -ge "$FAILS_TO_RESTART" ] && restart worker "$WORKER_CONTAINER" "пульс тиков молчит дольше 10 минут"
    exit 0
  fi
  reset worker
  exit 0
fi

# 3. Ответа нет вовсе (таймаут, 502/504 от nginx) — завис api или web.
if in_grace api || in_grace web; then say "api/web недавно перезапущены — жду подъёма"; exit 0; fi
n="$(bump api)"
say "API не ответил (код $CODE, $n подряд)"
if [ "$n" -ge "$FAILS_TO_RESTART" ]; then
  API_HEALTH="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$API_CONTAINER" 2>/dev/null || echo missing)"
  if [ "$API_HEALTH" = "healthy" ]; then
    restart web "$WEB_CONTAINER" "api внутри здоров, а снаружи не отвечает (код $CODE)"
    rm -f "$STATE_DIR/api.fails"
  else
    restart api "$API_CONTAINER" "не отвечает $n мин подряд (код $CODE, Docker: $API_HEALTH)"
  fi
fi
exit 0
