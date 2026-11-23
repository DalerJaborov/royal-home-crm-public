#!/usr/bin/env bash
# Готовность приёма звонков: только чтение, ничего не меняет.
#  1) Meta: Health Status номера → can_receive_call_sip (AVAILABLE | LIMITED | BLOCKED);
#  2) наш шлюз: контейнер healthy, сертификат проходит проверку, станция по VPN на связи.
#
#   wa-health.sh            — печать; код 0 только если всё зелёное
#   wa-health.sh --alert    — то же, при красном — тревога в Telegram (для cron)
#   wa-health.sh --local    — только наша сторона, без запроса к Meta
set -euo pipefail
# shellcheck source=ops/whatsapp-gateway/bin/wa-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wa-lib.sh"
wa_parse_common "$@"; set -- "${WA_ARGS[@]}"
ALERT=0; LOCAL_ONLY=0
for a in "$@"; do
  case "$a" in --alert) ALERT=1 ;; --local) LOCAL_ONLY=1 ;; *) wa_die "неизвестный флаг $a" ;; esac
done
wa_require_root
wa_load_env

problems=()
if [ "$DRY_RUN" = "1" ]; then
  wa_run docker inspect -f '{{.State.Health.Status}}' "$WA_CONTAINER"
  wa_run openssl s_client -verify_hostname "$WA_SIP_HOST" -connect "$WA_SIP_HOST:${WA_TLS_PORT:-5061}"
  wa_run docker exec "$WA_CONTAINER" asterisk -rx "pjsip show contacts"
  [ "$LOCAL_ONLY" = "1" ] || wa_graph health
  exit 0
fi

state="$(docker inspect -f '{{.State.Health.Status}}' "$WA_CONTAINER" 2>/dev/null || echo "нет контейнера")"
wa_log "шлюз: $state"
[ "$state" = "healthy" ] || problems+=("шлюз: $state")

# Без -quiet: он включает -ign_eof, и s_client против Asterisk не выходит по концу
# ввода (timeout → 124, с pipefail вся цепочка «ложь» при годном сертификате). grep без
# -q: ранний выход grep обрывал бы трубу (SIGPIPE) при том же pipefail. 18.11.2026.
if echo | timeout 10 openssl s_client -verify_hostname "$WA_SIP_HOST" -connect "$WA_SIP_HOST:${WA_TLS_PORT:-5061}" 2>&1 | grep "Verify return code: 0 (ok)" >/dev/null; then
  wa_log "сертификат $WA_SIP_HOST: проверку проходит"
else
  problems+=("сертификат $WA_SIP_HOST не проходит проверку")
fi
days_left="$(openssl x509 -in "$WA_HOME/certs/fullchain.pem" -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
if [ -n "$days_left" ]; then
  wa_log "сертификат действует до $days_left"
  openssl x509 -in "$WA_HOME/certs/fullchain.pem" -noout -checkend $((14*86400)) >/dev/null || problems+=("сертификат истекает меньше чем через 14 дней")
fi

if [ "$state" = "healthy" ]; then
  if docker exec "$WA_CONTAINER" asterisk -rx "pjsip show contacts" | grep -E "station" | grep -q "Avail"; then
    wa_log "станция по VPN: на связи"
  else
    problems+=("станция по VPN не отвечает (OPTIONS)")
  fi
fi

# Правило rh-wa-acme (порт 80 открыт всем на время certbot, wa-cert.sh) вне работающего
# wa-cert.sh — остаток прерванного запуска: порт 80 открыт всему интернету.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "# rh-wa-acme" && ! pgrep -f "wa-cert\.sh" >/dev/null 2>&1; then
  problems+=("порт 80 открыт всем правилом rh-wa-acme вне выпуска сертификата — снять: ufw status numbered, удалить rh-wa-acme")
fi

if [ "$LOCAL_ONLY" != "1" ]; then
  set +e
  wa_graph health
  rc=$?
  set -e
  [ "$rc" = "0" ] || problems+=("Meta: can_receive_call_sip не AVAILABLE (код $rc)")
fi

# Тревога — только при смене состояния (красное впервые / снова зелёное), а не
# каждый час, пока красное: иначе сообщения перестают читать.
STATE_DIR=/var/lib/royalhome-wa-gateway
prev="$(cat "$STATE_DIR/health.state" 2>/dev/null || echo "ok")"
if [ "${#problems[@]}" -gt 0 ]; then
  msg="$(printf '%s; ' "${problems[@]}")"
  wa_log "КРАСНОЕ: $msg"
  if [ "$ALERT" = "1" ]; then
    mkdir -p "$STATE_DIR"
    if [ "$prev" != "$msg" ]; then wa_alert "$msg"; fi
    printf '%s' "$msg" > "$STATE_DIR/health.state"
  fi
  exit 1
fi
wa_log "всё зелёное"
if [ "$ALERT" = "1" ] && [ "$prev" != "ok" ]; then
  wa_alert "снова зелёное (было: $prev)"
  printf 'ok' > "$STATE_DIR/health.state"
fi
