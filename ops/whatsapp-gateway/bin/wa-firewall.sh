#!/usr/bin/env bash
# Правила ufw для шлюза: TLS 5061/tcp и звук (WA_RTP_START:WA_RTP_END/udp)
# открыты ТОЛЬКО сетям Meta (AS32934). Остальной интернет до шлюза не достаёт.
#
# Список сетей Meta — тот же, что у вебхуков, и Meta его периодически меняет:
#   whois -h whois.radb.net -- '-i origin AS32934'
# [https://developers.facebook.com/docs/whatsapp/cloud-api/calling/sip → IP addresses;
#  …/whatsapp/webhooks/overview → IP addresses]. Фильтр — по адресу источника
# пакета (ufw так и делает), а не по заголовку Via [там же].
#
#   wa-firewall.sh apply [--dry-run]   свести правила с текущим списком (cron раз в сутки)
#   wa-firewall.sh remove [--dry-run]  убрать все правила шлюза (откат)
#   wa-firewall.sh show                правила шлюза сейчас
#
# Правила помечены комментарием «rh-wa-sip»: скрипт трогает только их.
# Только IPv4: у имени шлюза нет записи AAAA, Meta приходит по IPv4.
set -euo pipefail
# shellcheck source=ops/whatsapp-gateway/bin/wa-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wa-lib.sh"
wa_parse_common "$@"; set -- "${WA_ARGS[@]}"
op="${1:-}"
case "$op" in apply|remove|show) ;; *) wa_die "использование: wa-firewall.sh apply|remove|show [--dry-run]" ;; esac
wa_require_root
wa_load_env

TAG="rh-wa-sip"
TLS_PORT="${WA_TLS_PORT:-5061}"
RTP_RANGE="${WA_RTP_START:-41000}:${WA_RTP_END:-41199}"
# Не меньше стольких сетей после свёртки — иначе ответ whois битый (замер
# 17.11.2026: 824 записи route → 445 уникальных → 22 после свёртки).
MIN_NETS="${WA_MIN_META_NETS:-10}"
# Адреса Meta из примеров документации SIP (Via/received, c= в SDP): если
# список их не покрывает — он неполный, и применять его нельзя.
PROBES=(157.240.19.130 57.144.135.35 69.171.251.112 31.13.66.215)

current_rules() {
  # «5061/tcp  ALLOW IN  157.240.0.0/16  # rh-wa-sip» → «tcp 5061 157.240.0.0/16»
  # Колонка «From» — поле прямо перед «#» комментария (в «ALLOW» нет пробелов,
  # но держимся за комментарий, а не за номер колонки).
  ufw status | awk -v tag="$TAG" '{
      for (i = 1; i <= NF; i++) if ($i == "#" && $(i + 1) == tag) {
        split($1, pp, "/"); print pp[2], pp[1], $(i - 1) } }' | sort -u
}

if [ "$op" = "show" ]; then
  if [ "$DRY_RUN" = "1" ]; then wa_run ufw status; exit 0; fi
  current_rules
  exit 0
fi

if [ "$op" = "remove" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] ufw delete allow proto <tcp|udp> from <сеть Meta> to any port <порт> — для каждого правила с комментарием %s\n' "$TAG"
    exit 0
  fi
  n=0
  while read -r proto port net; do
    [ -n "$net" ] || continue
    ufw delete allow proto "$proto" from "$net" to any port "$port" >/dev/null
    n=$((n + 1))
  done < <(current_rules)
  wa_log "удалено правил: $n"
  exit 0
fi

# --- apply ---
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# whois.radb.net иногда отвечает «Connection refused» (замер 17.11.2026: первый
# запрос отказ, второй через секунды — ответ) — три попытки с паузой.
got=0
for attempt in 1 2 3; do
  if timeout 60 whois -h whois.radb.net -- '-i origin AS32934' > "$tmp/whois.txt" 2>/dev/null \
     && grep -q '^route:' "$tmp/whois.txt"; then got=1; break; fi
  wa_log "whois: попытка $attempt не удалась"
  [ "$attempt" = 3 ] || sleep 20
done
if [ "$got" != 1 ]; then
  wa_alert "не удалось получить список сетей Meta (whois) — правила файрвола оставлены прежними"
  wa_die "whois не ответил — правила НЕ менялись"
fi
awk '/^route:/{print $2}' "$tmp/whois.txt" | sort -u > "$tmp/routes.txt"
python3 - "$tmp/routes.txt" "${PROBES[@]}" > "$tmp/nets.txt" <<'PY'
import ipaddress, sys
nets = [ipaddress.ip_network(l.strip(), strict=False) for l in open(sys.argv[1]) if l.strip()]
collapsed = list(ipaddress.collapse_addresses(n for n in nets if n.version == 4))
for probe in sys.argv[2:]:
    if not any(ipaddress.ip_address(probe) in n for n in collapsed):
        sys.stderr.write(f"адрес Meta {probe} из документации не покрыт списком\n")
        sys.exit(3)
for n in collapsed:
    print(n)
PY
count="$(wc -l < "$tmp/nets.txt")"
[ "$count" -ge "$MIN_NETS" ] || { wa_alert "список сетей Meta подозрительно мал ($count) — правила не менялись"; wa_die "сетей $count < $MIN_NETS"; }

while read -r net; do
  printf 'tcp %s %s\nudp %s %s\n' "$TLS_PORT" "$net" "$RTP_RANGE" "$net"
done < "$tmp/nets.txt" | sort -u > "$tmp/want.txt"
if [ "$DRY_RUN" = "1" ]; then : > "$tmp/have.txt"; else current_rules > "$tmp/have.txt"; fi

comm -13 "$tmp/have.txt" "$tmp/want.txt" > "$tmp/add.txt"
comm -23 "$tmp/have.txt" "$tmp/want.txt" > "$tmp/del.txt"
wa_log "сетей Meta: $count; правил нужно: $(wc -l < "$tmp/want.txt"), добавить: $(wc -l < "$tmp/add.txt"), убрать: $(wc -l < "$tmp/del.txt")"

# Сначала добавить новые, потом убрать старые: в промежутке открыто больше, а не
# меньше — звонок, идущий во время обновления, не рвётся.
ufw_q() { if [ "$DRY_RUN" = "1" ]; then printf '  [dry-run] ufw %s\n' "$*"; else ufw "$@" >/dev/null; fi; }
while read -r proto port net; do
  ufw_q allow proto "$proto" from "$net" to any port "$port" comment "$TAG"
done < "$tmp/add.txt"
while read -r proto port net; do
  ufw_q delete allow proto "$proto" from "$net" to any port "$port"
done < "$tmp/del.txt"
if [ "$DRY_RUN" = "1" ]; then
  wa_log "первые правила плана:"; head -6 "$tmp/want.txt" | sed 's/^/    /'
fi
wa_log "готово"
