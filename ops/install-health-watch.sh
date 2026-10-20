#!/usr/bin/env bash
# Ставит ops/health-watch.sh в cron root раз в минуту. Повторный запуск ничего
# не дублирует. Запуск на сервере одной строкой:
#   cd /opt/royalhome-crm && sudo ./ops/install-health-watch.sh
# Снять: sudo ./ops/install-health-watch.sh --remove
set -eu

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="# royalhome-crm health-watch"
LINE="* * * * * $REPO_DIR/ops/health-watch.sh >> /var/log/crm-health-watch.log 2>&1"

current="$(crontab -l 2>/dev/null || true)"
without="$(printf '%s\n' "$current" | grep -vF "$MARKER" | grep -vF "ops/health-watch.sh" || true)"

if [ "${1:-}" = "--remove" ]; then
  printf '%s\n' "$without" | sed '/^$/d' | crontab -
  echo "сторож снят"
  exit 0
fi

chmod +x "$REPO_DIR/ops/health-watch.sh"
mkdir -p /var/lib/royalhome-health-watch
{ printf '%s\n' "$without" | sed '/^$/d'; echo "$MARKER"; echo "$LINE"; } | crontab -

# Первая проверка сразу — чтобы увидеть, что сторож видит сервер здоровым.
"$REPO_DIR/ops/health-watch.sh"
if [ -z "$(ls /var/lib/royalhome-health-watch/*.fails 2>/dev/null)" ]; then
  echo "готово: сторож стоит, сервер здоров"
else
  echo "сторож стоит, но сервер сейчас отвечает не так — смотри /var/log/crm-health-watch.log"
fi
