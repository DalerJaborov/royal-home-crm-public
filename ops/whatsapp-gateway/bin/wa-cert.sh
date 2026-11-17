#!/usr/bin/env bash
# Сертификат Let's Encrypt для имени шлюза (WA_SIP_HOST) — проверкой через DNS
# Cloudflare (DNS-01).
#
# ПОЧЕМУ DNS-01. HTTP-проверке нужен порт 80 этого имени, открытый всему
# интернету, а у сервера 80/443 открыты только сетям Cloudflare (ufw, 04.11.2026);
# само имя шлюза идёт мимо Cloudflare («серое облако», SIP Cloudflare не
# проксирует). Caddy на сервере DNS-модулей не имеет (caddy list-modules, 17.11).
# DNS-01 не открывает ни одного порта: certbot кладёт TXT-запись через API
# Cloudflare ключом с правом «DNS: Edit» только на зону royalhome.tj.
#
#   wa-cert.sh issue  [--dry-run]   первый выпуск (принимает условия Let's Encrypt)
#   wa-cert.sh renew  [--dry-run]   продление, если осталось < 30 дней (cron дважды в сутки)
#   wa-cert.sh status               срок действующего сертификата
#
# Ключ Cloudflare: $WA_HOME/secrets/cloudflare.ini (600), строка
#   dns_cloudflare_api_token = <ключ>
# кладёт владелец/инженер (runbook); в шлюз этот файл не монтируется.
#
# После выпуска/продления сертификат копируется в $WA_HOME/certs, и шлюз
# перезапускается ТОЛЬКО если в нём нет ни одного звонка; иначе — повтор на
# следующем запуске cron (старый сертификат действует ещё ≥ 29 дней).
set -euo pipefail
# shellcheck source=ops/whatsapp-gateway/bin/wa-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wa-lib.sh"
wa_parse_common "$@"; set -- "${WA_ARGS[@]}"
op="${1:-}"
case "$op" in issue|renew|status) ;; *) wa_die "использование: wa-cert.sh issue|renew|status [--dry-run]" ;; esac
wa_require_root
wa_load_env

LE_DIR="$WA_HOME/letsencrypt"
CERT_DIR="$WA_HOME/certs"
CF_INI="$WA_HOME/secrets/cloudflare.ini"
live="$LE_DIR/live/$WA_SIP_HOST"

if [ "$op" = "status" ]; then
  if [ -f "$CERT_DIR/fullchain.pem" ]; then
    openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -subject -issuer -enddate
  else
    wa_log "сертификата ещё нет ($CERT_DIR/fullchain.pem)"
  fi
  exit 0
fi

if [ "$DRY_RUN" != "1" ]; then
  [ -s "$CF_INI" ] || wa_die "нет ключа Cloudflare $CF_INI (runbook: «что владелец делает сам»)"
  perm="$(stat -c %a "$CF_INI")"
  [ "$perm" = "600" ] || [ "$perm" = "400" ] || wa_die "$CF_INI должен быть 600, сейчас $perm"
  docker image inspect "$WA_IMAGE" >/dev/null 2>&1 || wa_die "нет образа $WA_IMAGE — сначала сборка шлюза (runbook)"
  case "${WA_ACME_EMAIL:-}" in *@*.*) ;; *) wa_die "WA_ACME_EMAIL не задан в $WA_ENV_FILE" ;; esac
fi

certbot_run() {
  wa_run docker run --rm --network host \
    -v "$LE_DIR:/etc/letsencrypt" \
    -v "$CF_INI:/run/cloudflare.ini:ro" \
    --entrypoint certbot "$WA_IMAGE" "$@"
}

before=""
[ -f "$live/cert.pem" ] && before="$(openssl x509 -in "$live/cert.pem" -noout -fingerprint -sha256)"

wa_run install -d -m 700 "$LE_DIR"
if [ "$op" = "issue" ]; then
  # --agree-tos: принятие условий Let's Encrypt — часть операции «выпустить
  # сертификат», на которую владелец даёт «да».
  certbot_run certonly --non-interactive --agree-tos -m "${WA_ACME_EMAIL:-<почта>}" \
    --dns-cloudflare --dns-cloudflare-credentials /run/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30 \
    --key-type rsa --rsa-key-size 2048 \
    --cert-name "$WA_SIP_HOST" -d "$WA_SIP_HOST"
else
  certbot_run renew --non-interactive --cert-name "$WA_SIP_HOST" \
    --dns-cloudflare-credentials /run/cloudflare.ini
fi
[ "$DRY_RUN" = "1" ] && { wa_log "дальше: копия в $CERT_DIR и перезапуск шлюза, если нет звонков"; exit 0; }

[ -f "$live/fullchain.pem" ] || wa_die "certbot не создал $live/fullchain.pem"
after="$(openssl x509 -in "$live/cert.pem" -noout -fingerprint -sha256)"
restart_gateway() {
  if ! docker inspect "$WA_CONTAINER" >/dev/null 2>&1; then
    wa_log "шлюз ещё не запущен — сертификат подхватится при запуске"
    rm -f "$CERT_DIR/.pending-restart"
    return 0
  fi
  local calls
  calls="$(docker exec "$WA_CONTAINER" asterisk -rx "core show channels count" | awk '/active call/{print $1}')"
  if [ "${calls:-1}" != "0" ]; then
    touch "$CERT_DIR/.pending-restart"
    wa_log "в шлюзе идёт звонок (${calls:-?}) — перезапуск отложен до следующего запуска"
    exit 75
  fi
  docker restart "$WA_CONTAINER" >/dev/null
  rm -f "$CERT_DIR/.pending-restart"
  wa_log "шлюз перезапущен с новым сертификатом"
}

if [ "$before" = "$after" ] && [ -f "$CERT_DIR/fullchain.pem" ] && cmp -s "$live/fullchain.pem" "$CERT_DIR/fullchain.pem"; then
  if [ -f "$CERT_DIR/.pending-restart" ]; then
    wa_log "прошлый перезапуск был отложен — пробую снова"
    restart_gateway
  else
    wa_log "сертификат не менялся — шлюз не трогаю"
  fi
  exit 0
fi

# Копия для шлюза: certbot хранит в live/ ссылки на archive/, а в контейнер
# монтируется плоский каталог.
install -d -m 755 "$CERT_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
[ -f "$CERT_DIR/fullchain.pem" ] && cp -p "$CERT_DIR/fullchain.pem" "$CERT_DIR/fullchain.pem.bak-$stamp"
[ -f "$CERT_DIR/privkey.pem" ] && cp -p "$CERT_DIR/privkey.pem" "$CERT_DIR/privkey.pem.bak-$stamp"
install -m 644 "$(readlink -f "$live/fullchain.pem")" "$CERT_DIR/fullchain.pem"
install -m 600 "$(readlink -f "$live/privkey.pem")" "$CERT_DIR/privkey.pem"
wa_log "новый сертификат: $(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -enddate)"

restart_gateway
