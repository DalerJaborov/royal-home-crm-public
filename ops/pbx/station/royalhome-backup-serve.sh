#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin  # cron даёт только /usr/bin:/bin, а ip/ss/iptables/asterisk лежат в /usr/sbin (09.10.2026)
# Отдаёт серверу CRM последнюю зашифрованную копию станции. Это forced command ключа
# royalhome_pbx_pull в /root/.ssh/authorized_keys (restrict,command=...): по этому ключу
# нельзя выполнить ничего, кроме трёх слов ниже. 08.10.2026.
set -eu
D=/var/spool/asterisk/backup/royalhome
case "${SSH_ORIGINAL_COMMAND:-latest}" in
  latest) cat "$D/latest.tgz.gpg" ;;
  name)   readlink "$D/latest.tgz.gpg" ;;
  list)   ls -1 "$D"/*.tgz.gpg ;;
  *) echo "denied: ${SSH_ORIGINAL_COMMAND}" >&2; exit 1 ;;
esac
