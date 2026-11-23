#!/usr/bin/env bash
# Расписание шлюза: продление сертификата, обновление сетей Meta в ufw,
# проверка готовности с тревогой в Telegram (только при смене состояния).
#
#   wa-cron.sh install [--dry-run]   записать /etc/cron.d/royalhome-wa-gateway + logrotate
#   wa-cron.sh remove  [--dry-run]   убрать оба файла (откат)
#
# Правило станции/сервера из ops/pbx/README.md: у cron PATH=/usr/bin:/bin, а
# ufw/iptables лежат в /usr/sbin — поэтому PATH в первой строке файла обязателен.
set -euo pipefail
# shellcheck source=ops/whatsapp-gateway/bin/wa-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wa-lib.sh"
wa_parse_common "$@"; set -- "${WA_ARGS[@]}"
op="${1:-}"
case "$op" in install|remove) ;; *) wa_die "использование: wa-cron.sh install|remove [--dry-run]" ;; esac
wa_require_root

CRON=/etc/cron.d/royalhome-wa-gateway
ROT=/etc/logrotate.d/royalhome-wa-gateway
LOG=/var/log/royalhome-wa-gateway.log

if [ "$op" = "remove" ]; then
  wa_run rm -f "$CRON" "$ROT"
  wa_log "расписание шлюза убрано"
  exit 0
fi

cron_body="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Шлюз WhatsApp -> АТС (ops/whatsapp-gateway). Ставит wa-cron.sh.
# Сертификат: certbot продлевает за 30 дней до конца; шлюз перезапускается без звонков.
17 3,15 * * * root $WA_HOME/bin/wa-cert.sh renew >> $LOG 2>&1
# Сети Meta меняются — сводим правила ufw раз в сутки.
41 4 * * * root $WA_HOME/bin/wa-firewall.sh apply >> $LOG 2>&1
# Готовность (наша сторона + can_receive_call_sip у Meta); тревога только при смене состояния.
7 * * * * root $WA_HOME/bin/wa-health.sh --alert >> $LOG 2>&1
"
rot_body="$LOG {
  weekly
  rotate 8
  compress
  missingok
  notifempty
}
"
if [ "$DRY_RUN" = "1" ]; then
  printf '  [dry-run] записать %s:\n%s\n  [dry-run] записать %s:\n%s\n' "$CRON" "$cron_body" "$ROT" "$rot_body"
  exit 0
fi
[ -f "$CRON" ] && cp -p "$CRON" "/root/royalhome-wa-gateway.cron.bak-$(date -u +%Y%m%dT%H%M%SZ)"
printf '%s' "$cron_body" > "$CRON"; chmod 644 "$CRON"
printf '%s' "$rot_body" > "$ROT"; chmod 644 "$ROT"
wa_log "записано: $CRON, $ROT"
