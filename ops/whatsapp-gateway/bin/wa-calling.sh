#!/usr/bin/env bash
# Звонки WhatsApp у Meta: включить / выключить / показать или спрятать кнопку.
#
#   wa-calling.sh enable  [--dry-run]   звонки + SIP на наш шлюз, кнопка СКРЫТА
#   wa-calling.sh disable [--dry-run]   звонки выключены (адрес SIP Meta помнит)
#   wa-calling.sh show-button | show-button-tj | hide-button [--dry-run]
#   wa-calling.sh status                только чтение: настройки звонков (без пароля)
#
# Каждая операция кроме status МЕНЯЕТ настройку номера у Meta — только с «да»
# владельца на эту операцию (runbook). Откат enable — disable; show-button — hide-button.
set -euo pipefail
# shellcheck source=ops/whatsapp-gateway/bin/wa-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wa-lib.sh"
wa_parse_common "$@"; set -- "${WA_ARGS[@]}"

op="${1:-}"
case "$op" in
  enable|disable|show-button|show-button-tj|hide-button|status) ;;
  *) wa_die "использование: wa-calling.sh enable|disable|show-button|show-button-tj|hide-button|status [--dry-run]" ;;
esac
wa_require_root
wa_load_env

if [ "$op" = "status" ]; then
  wa_graph settings
  exit 0
fi

if [ "$op" = "enable" ] && [ "$DRY_RUN" != "1" ]; then
  # Не включать звонки, пока шлюз не готов принять: иначе клиенты (через ссылки
  # и открытые чаты) звонят в пустоту, а Meta штрафует за неотвеченные.
  docker inspect -f '{{.State.Health.Status}}' "$WA_CONTAINER" 2>/dev/null | grep -qx healthy \
    || wa_die "шлюз $WA_CONTAINER не в состоянии healthy — сначала шаг «запустить шлюз»"
  # Без -quiet и без grep -q — см. wa-health.sh (18.11.2026: проверка всегда падала по таймауту).
  echo | timeout 10 openssl s_client -verify_hostname "$WA_SIP_HOST" -connect "$WA_SIP_HOST:${WA_TLS_PORT:-5061}" 2>&1 \
    | grep "Verify return code: 0 (ok)" >/dev/null || wa_die "сертификат $WA_SIP_HOST:${WA_TLS_PORT:-5061} не проходит проверку openssl — Meta его тоже не примет"
fi

wa_log "операция у Meta: $op (номер ${WA_PHONE_ID:-?})"
wa_graph "$op"
[ "$DRY_RUN" = "1" ] || wa_log "готово. Проверка: wa-calling.sh status; wa-health.sh"
