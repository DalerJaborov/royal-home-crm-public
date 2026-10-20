#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin  # cron даёт только /usr/bin:/bin, а ip/ss/iptables/asterisk лежат в /usr/sbin (09.10.2026)
# Royal Home: внешний адрес станции (eth1, 217.11.176.134) — только исходящий путь до сервера CRM.
# 08.10.2026. Всё, что приходит снаружи, отбрасывается; наружу через eth1 идёт только трафик
# на 85.198.70.182 (иначе чужой процесс сжёг бы лимит трафика у оператора).
# Трогает ТОЛЬКО интерфейс eth1: eth0 (транк, телефоны, туннели) не затрагивается.
set -u
VPS=85.198.70.182
GW=217.11.176.129
IF=eth1
IN=RH_ETH1_IN
OUT=RH_ETH1_OUT

start() {
  # дождаться интерфейса (до 60 с)
  for i in $(seq 1 30); do ip link show $IF >/dev/null 2>&1 && ip addr show $IF | grep -q 217.11.176.134 && break; sleep 2; done

  # цепочки создаём/пересобираем атомарно: сначала новая, потом подключение
  iptables -N $IN 2>/dev/null || iptables -F $IN
  iptables -A $IN -m state --state ESTABLISHED,RELATED -j ACCEPT
  iptables -A $IN -s $VPS -p tcp --dport 22 -j ACCEPT
  iptables -A $IN -s $VPS -p icmp -j ACCEPT
  iptables -A $IN -j DROP

  iptables -N $OUT 2>/dev/null || iptables -F $OUT
  iptables -A $OUT -d $VPS -j ACCEPT
  iptables -A $OUT -j DROP

  # подключить цепочки первой строкой (один раз), убрав старые разовые правила 08.10
  while iptables -D INPUT -i $IF -j DROP 2>/dev/null; do :; done
  while iptables -D INPUT -i $IF -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null; do :; done
  while iptables -D INPUT -s $VPS/32 -i $IF -p tcp -m tcp --dport 22 -j ACCEPT 2>/dev/null; do :; done
  while iptables -D INPUT -s $VPS/32 -i $IF -p icmp -j ACCEPT 2>/dev/null; do :; done
  iptables -C INPUT -i $IF -j $IN 2>/dev/null || iptables -I INPUT 1 -i $IF -j $IN
  iptables -C OUTPUT -o $IF -j $OUT 2>/dev/null || iptables -I OUTPUT 1 -o $IF -j $OUT

  # маршрут: только до сервера CRM
  ip route replace $VPS/32 via $GW dev $IF
}

stop() {
  iptables -D INPUT -i $IF -j $IN 2>/dev/null
  iptables -D OUTPUT -o $IF -j $OUT 2>/dev/null
  iptables -F $IN 2>/dev/null; iptables -X $IN 2>/dev/null
  iptables -F $OUT 2>/dev/null; iptables -X $OUT 2>/dev/null
  ip route del $VPS/32 via $GW dev $IF 2>/dev/null
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop"; exit 2 ;;
esac
