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

# Способ проверки (18.11.2026). dns — TXT-запись через API Cloudflare, нужен ключ
# secrets/cloudflare.ini. http — без ключа: Caddy сервера отдаёт файлы проверки
# для http://$WA_SIP_HOST/.well-known/acme-challenge/ из $ACME_WEBROOT (блок в
# /etc/caddy/Caddyfile, runbook), а порт 80, закрытый для всех, кроме Cloudflare,
# открывается всему интернету ТОЛЬКО на время работы certbot (правило с
# комментарием rh-wa-acme, снимается ловушкой выхода). Продление в режиме http
# запускает certbot лишь когда до конца срока < 30 дней — иначе порт не трогается.
ACME_METHOD="${WA_ACME_METHOD:-dns}"
ACME_WEBROOT="${WA_ACME_WEBROOT:-$WA_HOME/acme-webroot}"
case "$ACME_METHOD" in dns|http) ;; *) wa_die "WA_ACME_METHOD: dns | http" ;; esac

if [ "$DRY_RUN" != "1" ]; then
  if [ "$ACME_METHOD" = "dns" ]; then
    [ -s "$CF_INI" ] || wa_die "нет ключа Cloudflare $CF_INI (runbook: «что владелец делает сам»)"
    perm="$(stat -c %a "$CF_INI")"
    [ "$perm" = "600" ] || [ "$perm" = "400" ] || wa_die "$CF_INI должен быть 600, сейчас $perm"
  fi
  docker image inspect "$WA_IMAGE" >/dev/null 2>&1 || wa_die "нет образа $WA_IMAGE — сначала сборка шлюза (runbook)"
  case "${WA_ACME_EMAIL:-}" in *@*.*|none) ;; *) wa_die "WA_ACME_EMAIL не задан в $WA_ENV_FILE (адрес или none)" ;; esac
fi

certbot_run() {
  local mounts=(-v "$LE_DIR:/etc/letsencrypt")
  if [ "$ACME_METHOD" = "dns" ]; then mounts+=(-v "$CF_INI:/run/cloudflare.ini:ro"); else mounts+=(-v "$ACME_WEBROOT:/webroot"); fi
  wa_run docker run --rm --network host "${mounts[@]}" --entrypoint certbot "$WA_IMAGE" "$@"
}

ACME_RULE_OPEN=0
acme_port_close() {
  if [ "$ACME_RULE_OPEN" = "1" ]; then
    ufw delete allow proto tcp to any port 80 >/dev/null 2>&1 || wa_alert "не удалось закрыть порт 80 после проверки сертификата — закрыть руками: ufw delete allow proto tcp to any port 80"
    ACME_RULE_OPEN=0
    wa_log "порт 80 снова закрыт для всех, кроме Cloudflare"
  fi
}
acme_port_open() {
  [ "$ACME_METHOD" = "http" ] || return 0
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] ufw allow proto tcp to any port 80 comment rh-wa-acme   (на время certbot, потом delete)\n'
    return 0
  fi
  trap acme_port_close EXIT
  ufw allow proto tcp to any port 80 comment rh-wa-acme >/dev/null
  ACME_RULE_OPEN=1
  wa_log "порт 80 открыт на время проверки Let's Encrypt"
}

before=""
[ -f "$live/cert.pem" ] && before="$(openssl x509 -in "$live/cert.pem" -noout -fingerprint -sha256)"

if [ "${WA_ACME_EMAIL:-}" = "none" ]; then
  # Без почты: Let's Encrypt с 04.06.2025 писем об истечении не шлёт, за сроком
  # следит wa-health.sh — а адрес владельца не уходит наружу.
  acct=(--register-unsafely-without-email)
else
  acct=(-m "${WA_ACME_EMAIL:-<почта>}")
fi
if [ "$ACME_METHOD" = "dns" ]; then
  auth=(--dns-cloudflare --dns-cloudflare-credentials /run/cloudflare.ini --dns-cloudflare-propagation-seconds 30)
else
  auth=(--webroot -w /webroot)
fi

wa_run install -d -m 700 "$LE_DIR"
wa_run install -d -m 755 "$ACME_WEBROOT"
if [ "$op" = "issue" ]; then
  # --agree-tos: принятие условий Let's Encrypt — часть операции «выпустить
  # сертификат», на которую владелец даёт «да».
  acme_port_open
  certbot_run certonly --non-interactive --agree-tos "${acct[@]}" "${auth[@]}" \
    --key-type rsa --rsa-key-size 2048 \
    --cert-name "$WA_SIP_HOST" -d "$WA_SIP_HOST"
  acme_port_close
else
  if [ "$ACME_METHOD" = "http" ] && [ -f "$live/cert.pem" ] \
     && openssl x509 -in "$live/cert.pem" -noout -checkend $((30 * 86400)) >/dev/null; then
    wa_log "до конца срока больше 30 дней — продлевать рано, порт 80 не трогаю"
  else
    acme_port_open
    if [ "$ACME_METHOD" = "dns" ]; then
      certbot_run renew --non-interactive --cert-name "$WA_SIP_HOST" --dns-cloudflare-credentials /run/cloudflare.ini
    else
      certbot_run renew --non-interactive --cert-name "$WA_SIP_HOST"
    fi
    acme_port_close
  fi
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
