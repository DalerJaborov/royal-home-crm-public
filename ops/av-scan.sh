#!/usr/bin/env bash
# Еженедельный антивирус/руткит-скан VPS. Устанавливает clamav и rkhunter при
# первом запуске (идемпотентно — apt install пропускает уже стоящие пакеты),
# затем сканирует загруженные пользователями файлы (фото объектов, вложения
# переписки, видео) и корень системы на руткиты. Алерт — тот же Telegram, что
# у backup.sh/disk-watch.sh/restore-drill.sh.
#
# Cron (раз в неделю, ночью — clamscan по /uploads грузит диск и CPU):
#   0 5 * * 0 /opt/royalhome-crm/ops/av-scan.sh >> /var/log/crm-av-scan.log 2>&1
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "[av-scan] запускать через sudo/root" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Точка монтирования томов Docker на хосте — путь по умолчанию для volume без
# явного bind mount. Если тома вынесены на отдельный диск, переопределить
# через переменную окружения.
UPLOADS_ROOT="${CRM_UPLOADS_HOST_ROOT:-/var/lib/docker/volumes}"

log() { echo "[av-scan] $*"; }

alert() {
  local message="$1"
  echo "[av-scan][ALERT] $message" >&2
  if [ -f /opt/watchdog.env ]; then
    # shellcheck disable=SC1091
    . /opt/watchdog.env
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
      curl -fsS --max-time 10 \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d chat_id="${TELEGRAM_CHAT_ID}" \
        -d text="🦠 CRM av-scan on $(hostname): $message" >/dev/null 2>&1 || \
        echo "[av-scan][ERROR] алерт не доставлен в Telegram" >&2
    fi
  fi
}

# ── 1. Установка (один раз, дальше пропускается) ────────────────────────────
if ! command -v clamscan >/dev/null 2>&1 || ! command -v freshclam >/dev/null 2>&1; then
  log "устанавливаю clamav"
  apt-get update -qq
  apt-get install -y -qq clamav clamav-daemon >/dev/null
  systemctl stop clamav-freshclam >/dev/null 2>&1 || true
  freshclam || log "ВНИМАНИЕ: freshclam не обновил базы (сеть/лимит ClamAV) — сканирую тем, что есть"
  systemctl enable clamav-freshclam >/dev/null 2>&1 || true
  systemctl start clamav-freshclam >/dev/null 2>&1 || true
else
  freshclam || log "ВНИМАНИЕ: freshclam не обновил базы — сканирую тем, что есть"
fi

if ! command -v rkhunter >/dev/null 2>&1; then
  log "устанавливаю rkhunter"
  apt-get install -y -qq rkhunter >/dev/null
  rkhunter --update --nocolors || true
  rkhunter --propupd --nocolors || true
fi

# ── 2. ClamAV по загруженным файлам ──────────────────────────────────────────
# Сканируем только каталоги с файлами, полученными от пользователей/клиентов —
# не весь диск (это часы времени на скромном VPS и незачем: системные файлы
# ставятся из apt/docker-образов, а не загружаются пользователями).
CLAM_LOG="/var/log/clamav/crm-uploads-scan.log"
mkdir -p "$(dirname "$CLAM_LOG")"
log "запускаю clamscan по томам uploads (может занять минуты)"
FOUND=0
if command -v docker >/dev/null 2>&1; then
  for vol in royalhome-crm_uploads_data royalhome-crm_private_uploads_data royalhome-crm_property_video_data; do
    MP="$(docker volume inspect -f '{{ .Mountpoint }}' "$vol" 2>/dev/null || echo "")"
    [ -z "$MP" ] && { log "том $vol не найден, пропускаю"; continue; }
    clamscan -r --infected --no-summary "$MP" >> "$CLAM_LOG" 2>&1 || FOUND=1
  done
else
  alert "docker не найден — clamscan по томам не выполнен"
fi

if [ "$FOUND" = "1" ]; then
  alert "clamscan нашёл заражённые файлы — см. $CLAM_LOG на сервере. Файлы НЕ удалены автоматически."
else
  log "clamscan: заражений не найдено"
fi

# ── 3. rkhunter по системе ───────────────────────────────────────────────────
RKH_LOG="/var/log/rkhunter-crm.log"
log "запускаю rkhunter"
if ! rkhunter --check --skip-keypress --report-warnings-only --nocolors > "$RKH_LOG" 2>&1; then
  # rkhunter возвращает ненулевой код и при найденных предупреждениях, и при
  # системных ошибках проверки — текст лога решает, что это было.
  if grep -qi "warning" "$RKH_LOG"; then
    alert "rkhunter нашёл предупреждения — см. $RKH_LOG на сервере (часть может быть ложным срабатыванием после обновлений пакетов, проверить руками)"
  else
    alert "rkhunter завершился с ошибкой (не предупреждение) — см. $RKH_LOG"
  fi
else
  log "rkhunter: предупреждений нет"
fi

log "готово"
