#!/usr/bin/env bash
# Пароль SIP от Meta → сразу в файл secrets/meta/meta_sip_password (права 600).
# Ни на экран, ни в журнал значение не выводится: Graph отдаёт его только API
# (include_sip_credentials=true), а graph-call.mjs пишет в stdout один пароль,
# который здесь же уходит в файл.
#
#   wa-sip-password.sh [--dry-run]
#
# Пароль у Meta появляется после «wa-calling.sh enable». Применить: перезапуск
# шлюза (runbook, отдельная операция) — тогда шлюз начнёт проверять пароль.
# Откат: удалить файл и перезапустить шлюз (проверка пароля выключится).
set -euo pipefail
# shellcheck source=ops/whatsapp-gateway/bin/wa-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wa-lib.sh"
wa_parse_common "$@"; set -- "${WA_ARGS[@]}"
wa_require_root
wa_load_env

dir="$WA_HOME/secrets/meta"
target="$dir/meta_sip_password"
if [ "$DRY_RUN" = "1" ]; then
  wa_run install -d -m 700 "$dir"
  wa_graph sip-password
  printf '  [dry-run] stdout → %s (umask 077, временный файл → mv), на экран ничего\n' "$target"
  exit 0
fi

install -d -m 700 "$dir"
umask 077
tmp="$(mktemp "$dir/.meta_sip_password.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
if ! wa_graph sip-password > "$tmp"; then
  wa_die "пароль не получен (причина выше); старый файл не тронут"
fi
[ -s "$tmp" ] || wa_die "пустой ответ; старый файл не тронут"
if [ -f "$target" ] && cmp -s "$tmp" "$target"; then
  wa_log "пароль не изменился — файл $target оставлен как был"
  exit 0
fi
[ -f "$target" ] && cp -p "$target" "$target.bak-$(date -u +%Y%m%dT%H%M%SZ)"
chmod 600 "$tmp"
mv "$tmp" "$target"
trap - EXIT
wa_log "пароль записан в $target (600). Значение не показывается."
wa_log "чтобы шлюз начал его проверять: docker compose -f $WA_HOME/docker-compose.yml up -d --force-recreate"
