#!/usr/bin/env bash
# Установить (или обновить) копию шлюза из репозитория в $WA_HOME
# (/opt/royalhome-wa-gateway). Ничего не запускает: ни сборки, ни контейнера,
# ни файрвола — это отдельные операции runbook.
#
#   sudo ops/whatsapp-gateway/bin/wa-install.sh [--dry-run]
#
# Повторный запуск обновляет файлы шлюза; gateway.env, secrets/, certs/,
# letsencrypt/ НЕ трогает. Прежняя копия файлов — в $WA_HOME/backup-<время>/.
# Откат: rm -rf /opt/royalhome-wa-gateway (если шлюз ещё не запускался).
set -euo pipefail
# shellcheck source=ops/whatsapp-gateway/bin/wa-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wa-lib.sh"
wa_parse_common "$@"; set -- "${WA_ARGS[@]}"
wa_require_root

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$src/Dockerfile" ] && [ -f "$src/docker-compose.yml" ] || wa_die "не нашёл файлы шлюза рядом со скриптом ($src)"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [ -f "$WA_HOME/Dockerfile" ]; then
  wa_run mkdir -p "$WA_HOME/backup-$stamp"
  wa_run cp -a "$WA_HOME/Dockerfile" "$WA_HOME/entrypoint.sh" "$WA_HOME/docker-compose.yml" \
    "$WA_HOME/config" "$WA_HOME/bin" "$WA_HOME/backup-$stamp/"
fi
wa_run install -d -m 755 "$WA_HOME" "$WA_HOME/config" "$WA_HOME/bin" "$WA_HOME/certs"
wa_run install -d -m 700 "$WA_HOME/secrets" "$WA_HOME/secrets/meta" "$WA_HOME/letsencrypt"
wa_run install -m 644 "$src/Dockerfile" "$src/.dockerignore" "$src/docker-compose.yml" "$src/gateway.env.example" "$WA_HOME/"
wa_run install -m 755 "$src/entrypoint.sh" "$WA_HOME/entrypoint.sh"
for f in "$src"/config/*; do wa_run install -m 644 "$f" "$WA_HOME/config/"; done
for f in "$src"/bin/*; do
  case "$f" in *.sh) wa_run install -m 755 "$f" "$WA_HOME/bin/" ;; *) wa_run install -m 644 "$f" "$WA_HOME/bin/" ;; esac
done
if [ ! -f "$WA_HOME/gateway.env" ]; then
  wa_run install -m 600 "$src/gateway.env.example" "$WA_HOME/gateway.env"
  wa_log "создан $WA_HOME/gateway.env из примера — впишите WA_BUSINESS_NUMBER и WA_ACME_EMAIL (runbook, операция 2)"
else
  wa_log "gateway.env уже есть — не трогаю"
fi
wa_log "установлено в $WA_HOME. Ничего не запущено."
