#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin  # cron даёт только /usr/bin:/bin, а ip/ss/iptables/asterisk лежат в /usr/sbin (09.10.2026)
# Royal Home: сторож путей станция → сервер CRM (08.10.2026). Cron раз в 2 минуты.
#  1) маршрут 85.198.70.182 идёт через eth1 — иначе royalhome-eth1.sh start;
#  2) туннель royalhome-tunnel держит TCP-сессию к 85.198.70.182:22 — иначе после 3 промахов
#     подряд перезапуск службы;
#  3) OpenVPN: 10.9.0.1 отвечает на ping — иначе после 3 промахов перезапуск openvpn@rh-vps.
# Перезапуск одной службы не чаще раза в 10 минут. Журнал: /var/log/royalhome-watchdog.log.
set -u
# Сторож ДЕЙСТВУЕТ (перезапускает службы), поэтому «не смог проверить» и «проверил — лежит» — разные
# вещи: без приборов выходим молча, ничего не трогая. 09.10.2026 под cron без PATH команды ip/ss не
# находились, каждая проверка читалась как «лежит», и здоровый туннель перезапускался 68 раз за ночь.
for tool in ip ss ping systemctl; do
  command -v "$tool" >/dev/null 2>&1 || { logger -t royalhome-watchdog "нет команды $tool — проверка невозможна, ничего не трогаю"; exit 0; }
done
VPS=85.198.70.182; LOG=/var/log/royalhome-watchdog.log; ST=/var/run/royalhome-watchdog
mkdir -p "$ST"
log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }
fails(){ cat "$ST/$1" 2>/dev/null || echo 0; }
bump(){ echo $(( $(fails "$1") + 1 )) > "$ST/$1"; }
reset(){ echo 0 > "$ST/$1"; }
cooled(){ local f="$ST/$1.restart"; [ ! -e "$f" ] || [ $(( $(date +%s) - $(stat -c %Y "$f") )) -gt 600 ]; }
restart(){
  if ! cooled "$1"; then log "$1: нужен перезапуск, но прошлый был меньше 10 мин назад — жду"; return; fi
  systemctl restart "$1" && touch "$ST/$1.restart" && log "$1: перезапущен сторожем"
}
if ! ip route get $VPS 2>/dev/null | grep -q "dev eth1"; then
  log "маршрут до $VPS не через eth1 — royalhome-eth1.sh start"; /usr/local/sbin/royalhome-eth1.sh start
fi
if ss -tn state established "( dport = :22 )" 2>/dev/null | grep -q "$VPS:22"; then reset tunnel; else
  bump tunnel; log "туннель: нет сессии к $VPS:22 (промах $(fails tunnel))"
  [ "$(fails tunnel)" -ge 3 ] && { restart royalhome-tunnel; reset tunnel; }
fi
if ping -c2 -W2 10.9.0.1 >/dev/null 2>&1; then reset vpn; else
  bump vpn; log "VPN: 10.9.0.1 не отвечает (промах $(fails vpn))"
  [ "$(fails vpn)" -ge 3 ] && { restart openvpn@rh-vps; reset vpn; }
fi
exit 0
