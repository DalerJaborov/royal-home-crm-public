#!/usr/bin/env bash
# Запуск шлюза: проверить переменные, разложить сертификат и пароль Meta,
# собрать конфигурацию Asterisk из шаблонов и запустить его на переднем плане.
# Пароль Meta ни в журнал, ни на экран не выводится.
set -euo pipefail

log() { printf '[wa-entrypoint] %s\n' "$*"; }
die() { printf '[wa-entrypoint] ОШИБКА: %s\n' "$*" >&2; exit 1; }

: "${WA_PUBLIC_IP:?WA_PUBLIC_IP не задан (публичный IPv4 сервера)}"
: "${WA_SIP_HOST:?WA_SIP_HOST не задан (имя хоста с сертификатом)}"
: "${WA_BUSINESS_NUMBER:?WA_BUSINESS_NUMBER не задан (номер WhatsApp бизнеса цифрами, без +)}"
: "${WA_STATION_IP:?WA_STATION_IP не задан (адрес станции в VPN)}"
: "${WA_STATION_LOCAL_IP:?WA_STATION_LOCAL_IP не задан (адрес сервера в VPN)}"
export WA_TLS_PORT="${WA_TLS_PORT:-5061}"
export WA_LOCAL_SIP_PORT="${WA_LOCAL_SIP_PORT:-5070}"
export WA_STATION_PORT="${WA_STATION_PORT:-5062}"
export WA_STATION_DID="${WA_STATION_DID:-6501414}"
export WA_RTP_START="${WA_RTP_START:-41000}"
export WA_RTP_END="${WA_RTP_END:-41199}"
export WA_ANSWER_MODE="${WA_ANSWER_MODE:-early}"
export WA_RING_MAX="${WA_RING_MAX:-180}"
WA_REQUIRE_AUTH="${WA_REQUIRE_AUTH:-auto}"
WA_SECRETS_DIR="${WA_SECRETS_DIR:-/run/wa-secrets}"
WA_CERT_DIR="${WA_CERT_DIR:-/etc/wa-certs}"

ipv4='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
[[ "$WA_PUBLIC_IP" =~ $ipv4 ]] || die "WA_PUBLIC_IP не похож на IPv4: $WA_PUBLIC_IP"
[[ "$WA_STATION_IP" =~ $ipv4 ]] || die "WA_STATION_IP не похож на IPv4"
[[ "$WA_STATION_LOCAL_IP" =~ $ipv4 ]] || die "WA_STATION_LOCAL_IP не похож на IPv4"
[[ "$WA_BUSINESS_NUMBER" =~ ^[0-9]{8,15}$ ]] || die "WA_BUSINESS_NUMBER — только цифры, без +"
[[ "$WA_STATION_DID" =~ ^[0-9]{3,15}$ ]] || die "WA_STATION_DID — только цифры"
[[ "$WA_SIP_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || die "WA_SIP_HOST — недопустимые символы"
[[ "$WA_ANSWER_MODE" == early || "$WA_ANSWER_MODE" == relay ]] || die "WA_ANSWER_MODE: early | relay"
[[ "$WA_RING_MAX" =~ ^[0-9]{1,3}$ ]] || die "WA_RING_MAX — секунды числом"
for p in WA_TLS_PORT WA_LOCAL_SIP_PORT WA_STATION_PORT WA_RTP_START WA_RTP_END; do
  [[ "${!p}" =~ ^[0-9]{2,5}$ ]] || die "$p — номер порта"
done
(( WA_RTP_START < WA_RTP_END )) || die "WA_RTP_START должен быть меньше WA_RTP_END"
if [[ "$WA_ANSWER_MODE" == relay && "$WA_RING_MAX" -gt 25 ]]; then
  log "ВНИМАНИЕ: relay и WA_RING_MAX=$WA_RING_MAX > 25 — Meta может оборвать звонок раньше (~30–60 с)"
fi

# Адреса должны быть на интерфейсах хоста (network_mode: host). VPN (tun0)
# поднимается не мгновенно после перезагрузки — ждём до 120 с, а не падаем сразу:
# Asterisk, не сумевший привязать транспорт, сам повторять не станет.
wait_ip() {
  local ip="$1"
  for _ in $(seq 1 60); do
    if ip -o -4 addr show | awk '{print $4}' | cut -d/ -f1 | grep -qx "$ip"; then return 0; fi
    sleep 2
  done
  return 1
}
wait_ip "$WA_PUBLIC_IP" || die "адреса $WA_PUBLIC_IP нет на интерфейсах (ждали 120 с)"
wait_ip "$WA_STATION_LOCAL_IP" || die "адреса $WA_STATION_LOCAL_IP нет на интерфейсах — VPN до станции не поднят?"

# Сертификат: копия внутрь контейнера с владельцем asterisk (на хосте файлы
# принадлежат root, а Asterisk работает от asterisk).
[[ -s "$WA_CERT_DIR/fullchain.pem" && -s "$WA_CERT_DIR/privkey.pem" ]] \
  || die "нет сертификата в $WA_CERT_DIR (fullchain.pem, privkey.pem) — сначала wa-cert.sh issue"
install -o asterisk -g asterisk -m 0644 "$WA_CERT_DIR/fullchain.pem" /var/lib/asterisk/keys/wa-fullchain.pem
install -o asterisk -g asterisk -m 0600 "$WA_CERT_DIR/privkey.pem" /var/lib/asterisk/keys/wa-privkey.pem
cert_end="$(openssl x509 -in /var/lib/asterisk/keys/wa-fullchain.pem -noout -enddate | cut -d= -f2)"
openssl x509 -in /var/lib/asterisk/keys/wa-fullchain.pem -noout -checkend 0 >/dev/null \
  || die "сертификат просрочен ($cert_end)"
log "сертификат действует до $cert_end"

# Пароль Meta (digest). Пусто — проверка выключена (так шлюз живёт до шага
# «получить пароль Meta»: пароль появляется у Meta только после включения SIP).
umask 077
rm -f /etc/asterisk/pjsip_auth.conf
pw_file="$WA_SECRETS_DIR/meta_sip_password"
if [[ -s "$pw_file" && "$WA_REQUIRE_AUTH" != "no" ]]; then
  pw="$(tr -d '\r\n' < "$pw_file")"
  [[ -n "$pw" ]] || die "файл пароля Meta пуст"
  # «;» в конфигурации Asterisk начинает комментарий — экранируем.
  pw_escaped="${pw//;/\\;}"
  {
    printf '[meta-inbound]\ntype = auth\nauth_type = userpass\n'
    printf 'username = %s\n' "$WA_BUSINESS_NUMBER"
    printf 'password = %s\n' "$pw_escaped"
  } > /etc/asterisk/pjsip_auth.conf
  unset pw pw_escaped
  chown asterisk:asterisk /etc/asterisk/pjsip_auth.conf
  chmod 0600 /etc/asterisk/pjsip_auth.conf
  export WA_AUTH_LINE="auth = meta-inbound"
  log "проверка пароля Meta (digest) ВКЛЮЧЕНА"
else
  [[ "$WA_REQUIRE_AUTH" == "yes" ]] && die "WA_REQUIRE_AUTH=yes, а файла $pw_file нет"
  export WA_AUTH_LINE="; проверка пароля Meta выключена: нет файла пароля"
  log "ВНИМАНИЕ: проверка пароля Meta ВЫКЛЮЧЕНА (нет $pw_file) — защита только файрволом"
fi
umask 022

# Сборка конфигурации из шаблонов. envsubst — только по списку переменных,
# иначе он стёр бы переменные диалплана ${...}.
cp /etc/wa-gateway/asterisk.conf /etc/wa-gateway/logger.conf /etc/wa-gateway/modules.conf \
   /etc/wa-gateway/indications.conf /etc/asterisk/
envsubst '${WA_RTP_START} ${WA_RTP_END}' < /etc/wa-gateway/rtp.conf.tmpl > /etc/asterisk/rtp.conf
envsubst '${WA_SIP_HOST} ${WA_PUBLIC_IP} ${WA_TLS_PORT} ${WA_STATION_LOCAL_IP} ${WA_LOCAL_SIP_PORT} ${WA_STATION_IP} ${WA_STATION_PORT} ${WA_AUTH_LINE}' \
  < /etc/wa-gateway/pjsip.conf.tmpl > /etc/asterisk/pjsip.conf
envsubst '${WA_BUSINESS_NUMBER} ${WA_STATION_DID} ${WA_ANSWER_MODE} ${WA_RING_MAX}' \
  < /etc/wa-gateway/extensions.conf.tmpl > /etc/asterisk/extensions.conf
chown -R asterisk:asterisk /etc/asterisk
install -d -o asterisk -g asterisk -m 0755 /var/run/asterisk /var/log/asterisk /var/spool/asterisk

log "запуск Asterisk: TLS ${WA_PUBLIC_IP}:${WA_TLS_PORT}, к станции ${WA_STATION_LOCAL_IP}:${WA_LOCAL_SIP_PORT} -> ${WA_STATION_IP}:${WA_STATION_PORT}, RTP ${WA_RTP_START}-${WA_RTP_END}, режим ${WA_ANSWER_MODE}/${WA_RING_MAX}с"
exec /usr/sbin/asterisk -f -U asterisk -G asterisk -vvv
