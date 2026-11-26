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
# --- Номера бизнеса (26.11.2026: второй номер — «Арван») ----------------------
# Основной — WA_BUSINESS_NUMBER, как было: звонок на него идёт на станцию городским
# номером WA_STATION_DID, имя звонящего «WhatsApp». Дополнительные — WA_EXTRA_NUMBERS,
# через запятую или пробел, каждый «номер:phone_number_id[:метка]», например
#   WA_EXTRA_NUMBERS=992877914444:1476112588909838:Arvan
# Звонок на такой номер идёт на станцию его phone_number_id (по нему станция
# ставит метку линии, а CRM узнаёт бренд), имя звонящего «WhatsApp <метка>».
# Пусто — шлюз ровно прежний, с одним номером.
WA_EXTRA_NUMBERS="${WA_EXTRA_NUMBERS:-}"
wa_numbers=("$WA_BUSINESS_NUMBER")
wa_dids=("$WA_STATION_DID")
wa_names=("WhatsApp")
for item in ${WA_EXTRA_NUMBERS//,/ }; do
  IFS=: read -r x_num x_id x_label x_rest <<< "$item"
  [[ -z "${x_rest:-}" ]] || die "WA_EXTRA_NUMBERS: лишнее в «$item» (формат номер:phone_number_id[:метка])"
  [[ "$x_num" =~ ^[0-9]{8,15}$ ]] || die "WA_EXTRA_NUMBERS: номер «$x_num» — только цифры, без +"
  # 13+ цифр — так станция отличает phone_number_id от городского номера
  # (ops/asterisk/extensions_custom.conf, [from-trunk-whatsapp]).
  [[ "${x_id:-}" =~ ^[0-9]{13,20}$ ]] || die "WA_EXTRA_NUMBERS: у номера $x_num phone_number_id «${x_id:-}» — от 13 до 20 цифр"
  [[ -z "${x_label:-}" || "$x_label" =~ ^[A-Za-z0-9]{1,16}$ ]] || die "WA_EXTRA_NUMBERS: метка «$x_label» — латиница и цифры, до 16 знаков"
  for seen in "${wa_numbers[@]}"; do [[ "$seen" != "$x_num" ]] || die "WA_EXTRA_NUMBERS: номер $x_num указан дважды"; done
  wa_numbers+=("$x_num")
  wa_dids+=("$x_id")
  wa_names+=("WhatsApp${x_label:+ $x_label}")
done
log "номера бизнеса: ${wa_numbers[*]}"

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

# Пароль Meta (digest) — СВОЙ НА КАЖДЫЙ НОМЕР: Meta выдаёт его номеру
# (settings?include_sip_credentials=true), имя — номер бизнеса без «+».
# Файлы в $WA_SECRETS_DIR:
#   meta_sip_password.<номер> — пароль этого номера (wa-sip-password.sh --number=…);
#   meta_sip_password         — прежнее имя, пароль ОСНОВНОГО номера (обратная
#                               совместимость: шлюз с одним номером не трогаем).
# Каждый пароль — своя секция auth; конечная точка whatsapp перечисляет их все, и
# Asterisk пускает звонок, если имя и пароль сошлись хоть с одной. Пароль одного
# номера к другому номеру не подходит: секция сверяет и имя (проверено run-e2e.sh).
# Пароля нет ни у одного номера — проверка выключена (так шлюз живёт до шага
# «получить пароль Meta»). Есть хоть у одного — включена для всех: номер без
# пароля тогда не пустит НИКОГО (защита по умолчанию), об этом строка в журнале.
umask 077
rm -f /etc/asterisk/pjsip_auth.conf
: > /etc/asterisk/pjsip_auth.conf
auth_sections=()
missing_pw=()
for i in "${!wa_numbers[@]}"; do
  num="${wa_numbers[$i]}"
  pw_file="$WA_SECRETS_DIR/meta_sip_password.$num"
  if [[ ! -s "$pw_file" && "$i" == 0 ]]; then pw_file="$WA_SECRETS_DIR/meta_sip_password"; fi
  if [[ ! -s "$pw_file" ]]; then missing_pw+=("$num"); continue; fi
  pw="$(tr -d '\r\n' < "$pw_file")"
  [[ -n "$pw" ]] || die "файл пароля Meta $pw_file пуст"
  # «;» в конфигурации Asterisk начинает комментарий — экранируем.
  pw_escaped="${pw//;/\\;}"
  if [[ "$i" == 0 ]]; then section="meta-inbound"; else section="meta-inbound-$num"; fi
  {
    printf '[%s]\ntype = auth\nauth_type = userpass\n' "$section"
    printf 'username = %s\n' "$num"
    printf 'password = %s\n\n' "$pw_escaped"
  } >> /etc/asterisk/pjsip_auth.conf
  auth_sections+=("$section")
done
unset pw pw_escaped
if [[ "${#auth_sections[@]}" -gt 0 && "$WA_REQUIRE_AUTH" != "no" ]]; then
  [[ "$WA_REQUIRE_AUTH" != "yes" || "${#missing_pw[@]}" == 0 ]] \
    || die "WA_REQUIRE_AUTH=yes, а пароля Meta нет у номера: ${missing_pw[*]} (wa-sip-password.sh --number=…)"
  chown asterisk:asterisk /etc/asterisk/pjsip_auth.conf
  chmod 0600 /etc/asterisk/pjsip_auth.conf
  auth_list="$(IFS=,; printf '%s' "${auth_sections[*]}")"
  export WA_AUTH_LINE="auth = $auth_list"
  log "проверка пароля Meta (digest) ВКЛЮЧЕНА: $auth_list"
  for num in "${missing_pw[@]}"; do
    log "ВНИМАНИЕ: у номера $num нет пароля Meta — звонки на него будут отбиты (wa-sip-password.sh --number=$num)"
  done
else
  [[ "$WA_REQUIRE_AUTH" == "yes" ]] && die "WA_REQUIRE_AUTH=yes, а файлов пароля Meta в $WA_SECRETS_DIR нет"
  : > /etc/asterisk/pjsip_auth.conf
  export WA_AUTH_LINE="; проверка пароля Meta выключена: нет файла пароля"
  log "ВНИМАНИЕ: проверка пароля Meta ВЫКЛЮЧЕНА (нет файлов пароля в $WA_SECRETS_DIR) — защита только файрволом"
fi
umask 022

# Сборка конфигурации из шаблонов. envsubst — только по списку переменных,
# иначе он стёр бы переменные диалплана ${...}.
cp /etc/wa-gateway/asterisk.conf /etc/wa-gateway/logger.conf /etc/wa-gateway/modules.conf \
   /etc/wa-gateway/indications.conf /etc/asterisk/
envsubst '${WA_RTP_START} ${WA_RTP_END}' < /etc/wa-gateway/rtp.conf.tmpl > /etc/asterisk/rtp.conf
envsubst '${WA_SIP_HOST} ${WA_PUBLIC_IP} ${WA_TLS_PORT} ${WA_STATION_LOCAL_IP} ${WA_LOCAL_SIP_PORT} ${WA_STATION_IP} ${WA_STATION_PORT} ${WA_AUTH_LINE}' \
  < /etc/wa-gateway/pjsip.conf.tmpl > /etc/asterisk/pjsip.conf
envsubst '${WA_ANSWER_MODE} ${WA_RING_MAX}' \
  < /etc/wa-gateway/extensions.conf.tmpl > /etc/asterisk/extensions.conf
# Номера бизнеса — по три переменные на номер (смысл — в шапке [from-whatsapp]).
# Значения уже проверены выше: только цифры и латиница, кавычки и «;» не пройдут.
{
  printf '; Собрано entrypoint.sh из WA_BUSINESS_NUMBER и WA_EXTRA_NUMBERS. Руками не править.\n'
  for i in "${!wa_numbers[@]}"; do
    num="${wa_numbers[$i]}"
    printf 'exten => +%s,1,Set(GW_DID=%s)\n' "$num" "${wa_dids[$i]}"
    printf ' same => n,Set(GW_NAME=%s)\n' "${wa_names[$i]}"
    printf ' same => n,Set(__GW_BIZ=%s)\n' "$num"
    printf ' same => n,Goto(wa-in,s,1)\n'
    printf 'exten => %s,1,Goto(+%s,1)\n' "$num" "$num"
  done
} > /etc/asterisk/extensions_wa_numbers.conf
chown -R asterisk:asterisk /etc/asterisk
install -d -o asterisk -g asterisk -m 0755 /var/run/asterisk /var/log/asterisk /var/spool/asterisk

log "запуск Asterisk: TLS ${WA_PUBLIC_IP}:${WA_TLS_PORT}, к станции ${WA_STATION_LOCAL_IP}:${WA_LOCAL_SIP_PORT} -> ${WA_STATION_IP}:${WA_STATION_PORT}, RTP ${WA_RTP_START}-${WA_RTP_END}, режим ${WA_ANSWER_MODE}/${WA_RING_MAX}с"
exec /usr/sbin/asterisk -f -U asterisk -G asterisk -vvv
