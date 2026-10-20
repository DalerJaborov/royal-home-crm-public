#!/usr/bin/env bash
# Общие функции для скриптов ops/*.sh — прежде всего Telegram-алерт, вынесенный
# из backup.sh и disk-watch.sh (у обоих был свой копипаст одной и той же
# функции). Подключать так:
#   REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
#   # shellcheck source=ops/lib.sh
#   . "$REPO_DIR/ops/lib.sh"
#
# Требует переменную окружения WATCHDOG_ENV (по умолчанию /opt/watchdog.env) с
# TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID — тот же файл, что уже использует
# backup.sh и disk-watch.sh.

crm_telegram_alert() { # crm_telegram_alert <текст> [эмодзи-префикс]
  local text="$1" prefix="${2:-⚠️}"
  local env_file="${WATCHDOG_ENV:-/opt/watchdog.env}"
  if [ ! -f "$env_file" ]; then
    echo "[lib][WARN] $env_file не найден — алерт не отправлен" >&2
    return 1
  fi
  # shellcheck disable=SC1090
  . "$env_file"
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    echo "[lib][WARN] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы — алерт не отправлен" >&2
    return 1
  fi
  local tg
  tg="$(curl -fsS --max-time 10 \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_CHAT_ID}" \
    -d text="${prefix} CRM on $(hostname): ${text}" 2>&1)" || true
  case "$tg" in
    *'"ok":true'*) return 0 ;;
    *) echo "[lib][ERROR] алерт НЕ доставлен в Telegram: ${tg:0:120}" >&2; return 1 ;;
  esac
}
