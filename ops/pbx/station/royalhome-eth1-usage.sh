#!/bin/bash
# Royal Home: учёт трафика внешнего адреса станции (eth1) — оператор берёт деньги за гигабайты.
# 08.10.2026. Каждый час пишет счётчики интерфейса в /var/log/royalhome-eth1-usage.csv;
# счётчик обнуляется при перезагрузке станции — отчёт это учитывает.
#   royalhome-eth1-usage.sh log            — дописать строку (вызывает cron)
#   royalhome-eth1-usage.sh report [ГГГГ-ММ] — итог за месяц (по умолчанию текущий)
#   royalhome-eth1-usage.sh days [ГГГГ-ММ]   — по дням
IF=eth1
LOG=/var/log/royalhome-eth1-usage.csv
LIMIT_MB=${LIMIT_MB:-10240}

case "${1:-log}" in
  log)
    rx=$(cat /sys/class/net/$IF/statistics/rx_bytes 2>/dev/null) || exit 0
    tx=$(cat /sys/class/net/$IF/statistics/tx_bytes 2>/dev/null) || exit 0
    echo "$(date '+%F %T'),$rx,$tx" >> "$LOG"
    ;;
  report|days)
    month="${2:-$(date +%Y-%m)}"
    awk -F, -v month="$month" -v limit="$LIMIT_MB" -v mode="$1" '
      {
        d = substr($1, 1, 10)
        if (have) {
          if ($2 >= prx) drx = $2 - prx; else drx = $2      # счётчик сбросился (перезагрузка)
          if ($3 >= ptx) dtx = $3 - ptx; else dtx = $3
          if (substr($1, 1, 7) == month) { rx += drx; tx += dtx; dayrx[d] += drx; daytx[d] += dtx }
        }
        prx = $2; ptx = $3; have = 1
      }
      END {
        if (mode == "days") {
          for (d in dayrx) printf "%s  принято %7.1f МБ  отправлено %7.1f МБ\n", d, dayrx[d]/1048576, daytx[d]/1048576 | "sort"
          exit
        }
        tot = (rx + tx) / 1048576
        printf "месяц %s: принято %.1f МБ, отправлено %.1f МБ, всего %.1f МБ из %d МБ (%.1f%%)\n", month, rx/1048576, tx/1048576, tot, limit, tot / limit * 100
      }' "$LOG"
    ;;
  *) echo "usage: $0 log|report [ГГГГ-ММ]|days [ГГГГ-ММ]"; exit 2 ;;
esac
