#!/usr/bin/env bash
# Сторож VPS: диск, здоровье API, контейнер базы. Кладётся в cron раз в 15 минут:
#   */15 * * * * /opt/royalhome-crm/ops/disk-watch.sh >> /var/log/crm-watch.log 2>&1
#
# Ловит то, что убивает прод молча и заранее: диск, забитый бэкапами или логами
# (за 2-3 дня до полного отказа), упавший api-контейнер, умерший postgres.
# ВАЖНО: смерть самого VPS этот сторож не поймает — он живёт на нём же;
# для этого нужен внешний пинг (UptimeRobot) — решение владельца.
#
# Алерты — в тот же Telegram, что и у бэкапов (/opt/watchdog.env). Повтор одного
# и того же алерта — не чаще раза в 6 часов (файл-штамп в /tmp), иначе каждые
# 15 минут будет приходить одно и то же, и алерты начнут игнорировать.
set -u

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=ops/lib.sh
. "$REPO_DIR/ops/lib.sh"

DISK_LIMIT_PCT="${CRM_WATCH_DISK_LIMIT:-85}"
COOLDOWN_MIN=360

notify() { # notify <ключ-штампа> <текст>
  local key="$1" text="$2" stamp="/tmp/crm-watch-$1.stamp"
  echo "[watch][ALERT] $text" >&2
  # Свежий штамп — алерт уже уходил недавно, молчим.
  if [ -f "$stamp" ] && [ -n "$(find "$stamp" -mmin "-$COOLDOWN_MIN" 2>/dev/null)" ]; then
    return 0
  fi
  # Штамп кулдауна — ТОЛЬКО после подтверждённой доставки. Раньше штамп
  # ставился до отправки, а curl без -f считал успехом и 401 мёртвого токена:
  # сторож «отправлял» в никуда и сам же глушил повторы на 6 часов — вечная
  # тишина при формально работающем стороже (аудит №4).
  if crm_telegram_alert "watch: $text" "🔴"; then
    touch "$stamp"
  fi
}

clear_stamp() { rm -f "/tmp/crm-watch-$1.stamp"; }

# 1. Диск: корневой раздел.
USED_PCT="$(df -P / | awk 'NR==2 {gsub(/%/,""); print $5}')"
if [ "${USED_PCT:-0}" -ge "$DISK_LIMIT_PCT" ]; then
  notify disk "диск заполнен на ${USED_PCT}% (порог ${DISK_LIMIT_PCT}%)"
else
  clear_stamp disk
fi

# 2. Здоровье API — через nginx, как ходят реальные пользователи.
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:8080/api/v1/health || echo 000)"
if [ "$HTTP_CODE" != "200" ]; then
  notify api "API health вернул $HTTP_CODE"
else
  clear_stamp api
fi

# 3. Контейнер базы жив и отвечает.
if ! docker exec royalhome-crm-postgres-1 pg_isready -q 2>/dev/null; then
  notify db "postgres не отвечает на pg_isready"
else
  clear_stamp db
fi

# 4. Worker жив И РЕАЛЬНО ТИКАЕТ (аудит №4: смерть worker — Telegram-бот, звонки
#    и все кроны — была невидима: /health зелёный, сторож кронов живёт в самом
#    worker и умирает вместе с ним). Проверяем не только «контейнер запущен»,
#    но и свежесть пульса минутного тика в CronHeartbeat: crash-loop и вечный
#    hang выглядят одинаково — пульс старше 10 минут.
WORKER_STATE="$(docker inspect -f '{{.State.Status}}' royalhome-crm-worker-1 2>/dev/null || echo missing)"
if [ "$WORKER_STATE" != "running" ]; then
  notify worker "worker-контейнер не работает (state=$WORKER_STATE) — бот, звонки и кроны стоят"
else
  PG_USER="$(grep '^POSTGRES_USER=' /opt/royalhome-crm/.env.production 2>/dev/null | cut -d= -f2)"
  BEAT_AGE_MIN="$(docker exec royalhome-crm-postgres-1 psql -U "${PG_USER:-postgres}" -d royal_home_crm -tAc \
    "SELECT COALESCE(ROUND(EXTRACT(EPOCH FROM (now() - max(\"lastRunAt\")))/60), 9999) FROM \"CronHeartbeat\"" 2>/dev/null || echo check_failed)"
  case "$BEAT_AGE_MIN" in
    check_failed|"") : ;; # сам запрос не удался — об этом скажет проверка №3
    *)
      if [ "${BEAT_AGE_MIN%.*}" -ge 10 ] 2>/dev/null; then
        notify worker "worker запущен, но кроны молчат ${BEAT_AGE_MIN} мин (пульс CronHeartbeat)"
      else
        clear_stamp worker
      fi
      ;;
  esac
fi
