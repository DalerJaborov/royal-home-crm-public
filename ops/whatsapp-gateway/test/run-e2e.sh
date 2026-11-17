#!/usr/bin/env bash
# Локальная проверка шлюза целиком, без сервера и без Meta (нужен только Docker):
#
#   «Meta» (meta-sim) --TLS, проверка сертификата и имени, SDES, Opus+PCMA,
#                       заголовок X-FB-External-Domain, digest-пароль-->
#   ШЛЮЗ (образ royalhome-wa-gateway:local, ровно как на сервере)
#                     --SIP/UDP, a-law, «VPN» 10.9.0.1 -> 10.9.0.2:5062-->
#   «станция» (station-sim) с НАСТОЯЩИМИ файлами станции из ops/asterisk/
#   (pjsip.endpoint_custom_post.conf и extensions_custom.conf).
#
# Сценарии: ok (звонок доходит, номер приведён к 9 цифрам, метка whatsapp и ID
# звонка доехали, звук SRTP/SDES, a-law), nohdr / wrongnum / noauth — шлюз
# обязан отказать. В конце всё гасится: контейнеры, сети, временные ключи.
#
#   ops/whatsapp-gateway/test/run-e2e.sh [--keep] [--no-build]
#     --keep      не гасить контейнеры (для ручного разбора)
#     --no-build  не собирать образ, взять готовый royalhome-wa-gateway:local
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash на Windows: не переписывать пути /test/...

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gw_dir="$(cd "$here/.." && pwd)"
asterisk_dir="$(cd "$here/../../asterisk" && pwd)"
IMAGE="${WA_IMAGE:-royalhome-wa-gateway:local}"
KEEP=0; BUILD=1
for a in "$@"; do
  case "$a" in --keep) KEEP=1 ;; --no-build) BUILD=0 ;; *) echo "неизвестный флаг $a" >&2; exit 2 ;; esac
done

work="$(mktemp -d)"
# Путь для docker: в Git Bash на Windows docker.exe понимает только C:/…
hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
cleanup() {
  if [ "$KEEP" = "1" ]; then echo "контейнеры оставлены (--keep); файлы: $work"; return; fi
  docker rm -f wa-e2e-gw wa-e2e-station wa-e2e-meta >/dev/null 2>&1 || true
  docker network rm wa-e2e-vpn wa-e2e-pub >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
pass=0; fail=0
ok()   { echo "  ЗЕЛЁНОЕ: $*"; pass=$((pass + 1)); }
bad()  { echo "  КРАСНОЕ: $*"; fail=$((fail + 1)); }

if [ "$BUILD" = "1" ]; then
  echo "== сборка образа $IMAGE"
  docker build -q -t "$IMAGE" "$(hp "$gw_dir")" >/dev/null
fi

echo "== тестовые ключи (свой CA, сертификат на wa-sip.test, клиентский для meta-sim)"
mkdir -p "$work/certs" "$work/secrets-meta" "$work/station" "$work/meta"
docker run --rm -v "$(hp "$work/certs"):/w" --entrypoint bash "$IMAGE" -c '
  set -e; cd /w
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=wa-e2e-test-ca" -keyout ca.key -out ca.pem 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=wa-sip.test" -keyout privkey.pem -out gw.csr 2>/dev/null
  printf "subjectAltName=DNS:wa-sip.test\n" > ext.cnf
  openssl x509 -req -in gw.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile ext.cnf -out cert.pem 2>/dev/null
  cat cert.pem ca.pem > fullchain.pem
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=client.sip.fbclientcerts.test" -keyout meta-client.key -out meta-client.pem 2>/dev/null
  chmod 644 *.pem *.key'
pw="e2e-$(od -An -tx1 -N12 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$pw" > "$work/secrets-meta/meta_sip_password"
chmod 600 "$work/secrets-meta/meta_sip_password" 2>/dev/null || true

cp "$here"/station-sim/*.conf "$work/station/"
cp "$asterisk_dir/pjsip.endpoint_custom_post.conf" "$asterisk_dir/extensions_custom.conf" "$work/station/"
cp "$here"/meta-sim/*.conf "$work/meta/"
sed -i "s/__META_SIM_PASSWORD__/$pw/" "$work/meta/pjsip.conf"

echo "== сети: «интернет» 192.168.231.0/24 и «VPN» 10.9.0.0/24"
docker network create --subnet 192.168.231.0/24 wa-e2e-pub >/dev/null
docker network create --subnet 10.9.0.0/24 --gateway 10.9.0.254 wa-e2e-vpn >/dev/null

common_sim='cp /etc/wa-gateway/asterisk.conf /etc/wa-gateway/logger.conf /etc/wa-gateway/modules.conf /etc/wa-gateway/indications.conf /etc/asterisk/ && cp /sim/*.conf /etc/asterisk/ && chown -R asterisk:asterisk /etc/asterisk && exec /usr/sbin/asterisk -f -U asterisk -G asterisk -vvv'

echo "== станция (настоящие файлы ops/asterisk/)"
docker run -d --name wa-e2e-station --network wa-e2e-vpn --ip 10.9.0.2 \
  -v "$(hp "$work/station"):/sim:ro" --entrypoint bash "$IMAGE" -c "$common_sim" >/dev/null

echo "== шлюз (как на сервере: те же ограничения прав, что в docker-compose.yml)"
docker create --name wa-e2e-gw --network wa-e2e-pub --ip 192.168.231.20 --network-alias wa-sip.test \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add SETUID --cap-add SETGID --cap-add FOWNER \
  --security-opt no-new-privileges:true \
  -e WA_PUBLIC_IP=192.168.231.20 -e WA_SIP_HOST=wa-sip.test -e WA_BUSINESS_NUMBER=992900000001 \
  -e WA_STATION_IP=10.9.0.2 -e WA_STATION_LOCAL_IP=10.9.0.1 -e WA_REQUIRE_AUTH=yes \
  -v "$(hp "$work/certs"):/etc/wa-certs:ro" -v "$(hp "$work/secrets-meta"):/run/wa-secrets:ro" \
  "$IMAGE" >/dev/null
docker network connect --ip 10.9.0.1 wa-e2e-vpn wa-e2e-gw
docker start wa-e2e-gw >/dev/null

echo "== «Meta»"
docker run -d --name wa-e2e-meta --network wa-e2e-pub --ip 192.168.231.10 \
  -v "$(hp "$work/meta"):/sim:ro" -v "$(hp "$work/certs"):/test/certs:ro" --entrypoint bash "$IMAGE" -c "$common_sim" >/dev/null

echo "== ждём готовности"
for _ in $(seq 1 60); do
  if docker exec wa-e2e-gw asterisk -rx "pjsip show contacts" 2>/dev/null | grep -q "station.*Avail"; then break; fi
  sleep 2
done

echo "== шлюз: транспорты, конечные точки, диалплан"
gw() { docker exec wa-e2e-gw asterisk -rx "$1"; }
gw "pjsip show transports" | grep -E "transport-(tls|station)" | sed 's/^/    /'
gw "pjsip show transports" | grep -q "transport-tls  *tls.*192.168.231.20:5061" && ok "TLS 5061 на публичном адресе" || bad "нет транспорта TLS"
gw "pjsip show contacts" | grep -q "station.*Avail" && ok "станция по «VPN» отвечает на OPTIONS" || bad "станция недоступна"
gw "pjsip show endpoint whatsapp" | grep -qE "auth *: *meta-inbound" && ok "проверка пароля Meta включена" || bad "у whatsapp нет auth"
gw "dialplan show from-whatsapp" | grep -q "+992900000001" && ok "диалплан шлюза загружен" || bad "диалплан шлюза"
gw "module show like opus" | grep -q codec_opus && ok "Opus-перекодер есть (запас, если Meta не даст PCMA)" || bad "нет codec_opus"
docker exec wa-e2e-station asterisk -rx "dialplan show from-trunk-whatsapp" | grep -q "ext-did" && ok "станция: контекст from-trunk-whatsapp загружен" || bad "станция: нет from-trunk-whatsapp"
docker exec wa-e2e-station asterisk -rx "dialplan show royalhome-inbound" | grep -q "RH_CRM_VERDICT" && ok "станция: весь extensions_custom.conf разобран Asterisk 22" || bad "станция: royalhome-inbound не загружен"
docker exec wa-e2e-station asterisk -rx "pjsip show endpoint whatsapp-gw" | grep -q "from-trunk-whatsapp" && ok "станция: конечная точка whatsapp-gw" || bad "станция: нет whatsapp-gw"

gw "pjsip set logger on" >/dev/null
gw "rtp set debug on" >/dev/null
call() { docker exec wa-e2e-meta asterisk -rx "channel originate Local/$1@meta-test application Wait 8" >/dev/null; }
echo "== звонок «ok»"
call ok; sleep 12
echo "== звонки, которые шлюз обязан отбить: nohdr, wrongnum, noauth"
call nohdr; sleep 6
call wrongnum; sleep 6
call noauth; sleep 8
gw "pjsip set logger off" >/dev/null
gw "rtp set debug off" >/dev/null

docker logs wa-e2e-gw > "$work/gw.log" 2>&1
docker logs wa-e2e-station > "$work/station.log" 2>&1
docker logs wa-e2e-meta > "$work/meta.log" 2>&1

echo "== итоги"
grep -q "STATION-SIM: вход num=931234567 name=WhatsApp src=whatsapp wacid=wacid.TEST123" "$work/station.log" \
  && ok "станция получила звонок: номер 9 цифр, имя WhatsApp, метка whatsapp, ID звонка" || bad "станция не получила звонок как надо"
grep -q "STATION-SIM: ответ, кодек (alaw)" "$work/station.log" && ok "плечо до станции — a-law" || bad "кодек до станции не a-law"
grep -q "DIALSTATUS=ANSWER talk=[0-9]* HDR=1 TARGET=+992900000001@gw$" "$work/meta.log" && ok "«Meta»: звонок отвечен" || bad "«Meta»: звонок не отвечен"
grep -qE "m=audio [0-9]+ RTP/SAVP 8( |$)" "$work/gw.log" && ok "ответ шлюза Meta: SRTP (RTP/SAVP) и PCMA" || bad "в ответе шлюза нет RTP/SAVP 8"
grep -q "a=crypto:" "$work/gw.log" && ok "ключ SDES (a=crypto) в SDP" || bad "нет a=crypto"
# Звук: шлюз расшифровал пакеты «Meta» (Got … from) и отправил свои (Sent … to).
grep -aq "Got  RTP packet from    192.168.231.10" "$work/gw.log" && ok "звук от «Meta» принят и расшифрован (SRTP)" || bad "нет звука от «Meta»"
grep -aq "Sent RTP packet to      192.168.231.10" "$work/gw.log" && ok "звук к «Meta» уходит (в т.ч. гудки до ответа станции)" || bad "нет звука к «Meta»"
grep -aq "Got  RTP packet from    10.9.0.2" "$work/gw.log" && ok "звук от станции по «VPN» принят" || bad "нет звука от станции"
grep -qE "^(<--- Transmitting SIP response|.*SIP/2.0 401)" "$work/gw.log" && ok "шлюз требует пароль (401)" || bad "шлюз не спросил пароль"
grep -q "DIALSTATUS=.* talk=.* HDR=0 TARGET=+992900000001@gw$" "$work/meta.log" && ! grep -q "DIALSTATUS=ANSWER talk=[0-9]* HDR=0" "$work/meta.log" \
  && ok "без заголовка Meta — отказ" || bad "без заголовка Meta звонок прошёл"
grep -q "TARGET=+992900000099@gw$" "$work/meta.log" && ! grep -q "DIALSTATUS=ANSWER talk=[0-9]* HDR=1 TARGET=+992900000099" "$work/meta.log" \
  && ok "чужой номер — отказ" || bad "чужой номер прошёл"
grep -q "TARGET=+992900000001@gw-noauth$" "$work/meta.log" && ! grep -q "DIALSTATUS=ANSWER talk=[0-9]* HDR=1 TARGET=+992900000001@gw-noauth" "$work/meta.log" \
  && ok "без пароля — отказ" || bad "без пароля звонок прошёл"
if grep -q "$pw" "$work/gw.log"; then bad "пароль Meta попал в журнал шлюза"; else ok "пароля в журнале шлюза нет"; fi
grep -E "ERROR|Unable to load|Failed to load" "$work/gw.log" | grep -v "SIP/2.0" | head -5 | sed 's/^/    журнал шлюза: /' || true

echo "ЗЕЛЁНЫХ: $pass, КРАСНЫХ: $fail"
[ "$fail" = "0" ] || { echo "журналы: $work (с --keep останутся)"; exit 1; }
