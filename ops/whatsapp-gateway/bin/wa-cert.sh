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
ACME_TAG="rh-wa-acme"
# Номера НАШИХ правил (с комментарием rh-wa-acme) в `ufw status numbered`, по убыванию:
# удалять с конца, иначе номера сдвигаются после первого удаления. Удаляем ТОЛЬКО по
# номеру с нашим комментарием — `ufw delete allow … port 80` снёс бы и чужое правило
# с той же записью (ufw сравнивает правило без комментария).
acme_rule_numbers() {
  ufw status numbered 2>/dev/null | awk -v tag="# $ACME_TAG" 'index($0, tag) { gsub(/[][]/, " "); print $1 }' | sort -rn
}
acme_rules_delete() {
  local n left
  for n in $(acme_rule_numbers); do
    ufw --force delete "$n" >/dev/null 2>&1 || true
  done
  left="$(acme_rule_numbers | wc -l)"
  [ "$left" = "0" ]
}
# Порт 80 уже открыт ВСЕМ чужим правилом (не нашим) — тогда ничего не добавляем и не удаляем.
port80_open_by_others() {
  ufw status 2>/dev/null | grep -v "# $ACME_TAG" | grep -Eq '^80(/tcp)?( \(v6\))?[[:space:]]+ALLOW( IN)?[[:space:]]+Anywhere'
}
acme_port_close() {
  if [ "$ACME_RULE_OPEN" = "1" ]; then
    if acme_rules_delete; then
      wa_log "порт 80 снова закрыт для всех, кроме Cloudflare"
    else
      wa_alert "не удалось закрыть порт 80 после проверки сертификата — закрыть руками: ufw status numbered, удалить правила с комментарием $ACME_TAG"
    fi
    ACME_RULE_OPEN=0
  fi
}
acme_port_open() {
  [ "$ACME_METHOD" = "http" ] || return 0
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] ufw allow proto tcp to any port 80 comment %s   (на время certbot, потом удаление по номеру)
' "$ACME_TAG"
    return 0
  fi
  if port80_open_by_others; then
    wa_log "порт 80 уже открыт всем чужим правилом — своё не добавляю и чужое не трогаю"
    return 0
  fi
  trap acme_port_close EXIT
  # Флаг ДО команды: если ufw добавил правило и упал на выходе, ловушка всё равно его снимет.
  ACME_RULE_OPEN=1
  ufw allow proto tcp to any port 80 comment "$ACME_TAG" >/dev/null
  wa_log "порт 80 открыт на время проверки Let's Encrypt"
}

# Остатки прошлого запуска (SIGKILL, перезагрузка посреди certbot — ловушка выхода не
# сработала): наше правило висит и держит порт 80 открытым всем. Снимаем в начале.
if [ "$ACME_METHOD" = "http" ] && [ "$DRY_RUN" != "1" ] && [ -n "$(acme_rule_numbers)" ]; then
  if acme_rules_delete; then
    wa_log "снято оставшееся от прошлого запуска правило $ACME_TAG (порт 80)"
  else
    wa_alert "осталось правило $ACME_TAG (порт 80 открыт всем) и снять его не удалось — ufw status numbered"
  fi
fi

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
    # Способ проверки — ТЕКУЩИЙ (auth), а не тот, что certbot запомнил при выпуске:
    # сертификат, впервые выпущенный через dns, после перехода на http продлевается по http.
    certbot_run renew --non-interactive --cert-name "$WA_SIP_HOST" "${auth[@]}"
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
