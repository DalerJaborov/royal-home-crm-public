#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin  # cron даёт только /usr/bin:/bin, а ip/ss/iptables/asterisk лежат в /usr/sbin (09.10.2026)
# Royal Home: закрыть на eth0 (внутренняя сеть оператора, общая с чужими абонентами) служебные
# порты станции, которым снаружи делать нечего: MySQL, AMI, ARI/HTTP Asterisk, rpcbind, UCP-чат,
# IAX, PnP, mDNS, TLS-транспорты мёртвого браузерного софтфона. 08.10.2026.
# Политика INPUT остаётся ACCEPT: закрыто только перечисленное; SIP 5060, RTP 10000-20000,
# SSH 22 и панель 80/443 не трогаются. CRM всё перечисленное получает через обратный туннель
# на 127.0.0.1 — туннелю эти правила не мешают (lo не фильтруется).
set -u
IF=eth0; CH=RH_ETH0_GUARD
TCP="3306 5038 8088 8089 111 5000 5222 5061"
UDP="111 888 4569 60000 5353 5062"
start() {
  iptables -N $CH 2>/dev/null || iptables -F $CH
  for p in $TCP; do iptables -A $CH -p tcp --dport "$p" -j DROP; done
  for p in $UDP; do iptables -A $CH -p udp --dport "$p" -j DROP; done
  iptables -A $CH -j RETURN
  iptables -C INPUT -i $IF -j $CH 2>/dev/null || iptables -I INPUT 1 -i $IF -j $CH
}
stop() {
  iptables -D INPUT -i $IF -j $CH 2>/dev/null
  iptables -F $CH 2>/dev/null; iptables -X $CH 2>/dev/null
}
case "${1:-}" in start) start ;; stop) stop ;; *) echo "usage: $0 start|stop"; exit 2 ;; esac
