#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin  # cron даёт только /usr/bin:/bin, а ip/ss/iptables/asterisk лежат в /usr/sbin (09.10.2026)
# Резервная копия станции FreePBX Royal Home (v2, 08.10.2026).
# Что внутри: база FreePBX (asterisk), astdb, /etc/asterisk, наши службы/скрипты/cron/iptables,
# ключи туннеля и VPN, пароли SIP/AMI/ARI (/root/royalhome-*.txt), звуки royalhome, учёт трафика.
# Ежедневно (cron 03:20) — БЕЗ asteriskcdrdb (история звонков тяжёлая, а канал eth1 платный);
# по воскресеньям или с аргументом `full` — вместе с asteriskcdrdb.
# Архив шифруется gpg (пароль /root/.royalhome-backup-pass, копия пароля на сервере CRM
# /root/.royalhome-pbx-backup-pass). Сервер забирает latest.tgz.gpg через туннель
# (royalhome-backup-serve.sh) и кладёт в /backups/pbx и R2. Локально хранить 8 последних.
set -eu
D=/var/spool/asterisk/backup/royalhome
mkdir -p "$D"; chmod 700 "$D"
PASS=/root/.royalhome-backup-pass
if [ ! -s "$PASS" ]; then (umask 077; openssl rand -base64 36 > "$PASS"); fi
T=$(mktemp -d "$D/tmp-XXXXXX"); trap 'rm -rf "$T"' EXIT
KIND=daily
[ "$(date +%u)" = 7 ] && KIND=weekly
[ "${1:-}" = full ] && KIND=weekly

mysqldump --single-transaction asterisk > "$T/asterisk.sql"
if [ "$KIND" = weekly ]; then mysqldump --single-transaction asteriskcdrdb > "$T/asteriskcdrdb.sql"; fi
asterisk -rx "database show" > "$T/astdb.txt"
cp -a /etc/asterisk "$T/etc-asterisk"

mkdir -p "$T/system/systemd" "$T/system/cron.d" "$T/system/sbin" "$T/system/bin" "$T/secrets"
cp -a /etc/chrony.conf /etc/ssh/sshd_config /etc/resolv.conf "$T/system/" 2>/dev/null || true
cp -a /etc/sysconfig/network-scripts/ifcfg-eth0 /etc/sysconfig/network-scripts/ifcfg-eth1 "$T/system/" 2>/dev/null || true
cp -a /etc/openvpn "$T/system/openvpn" 2>/dev/null || true
cp -a /etc/systemd/system/royalhome-* "$T/system/systemd/" 2>/dev/null || true
cp -a /etc/cron.d/royalhome-* "$T/system/cron.d/" 2>/dev/null || true
crontab -l > "$T/system/root-crontab" 2>/dev/null || true
cp -a /usr/local/sbin/royalhome-* "$T/system/sbin/" 2>/dev/null || true
cp -a /usr/local/bin/royalhome-* "$T/system/bin/" 2>/dev/null || true
cp -a /etc/httpd/conf.d/royalhome-*.conf /etc/logrotate.d/royalhome* "$T/system/" 2>/dev/null || true
iptables-save > "$T/system/iptables.rules"
cp -a /root/royalhome-*.txt /root/.ssh/authorized_keys /root/.ssh/royalhome_tunnel* /root/.ssh/config "$T/secrets/" 2>/dev/null || true
cp -a /var/lib/asterisk/royalhome "$T/royalhome-sounds" 2>/dev/null || true
cp -a /var/log/royalhome-eth1-usage.csv "$T/" 2>/dev/null || true

OUT="$D/station-$(date +%F)-$KIND.tgz"
tar -C "$T" -czf "$OUT" .
chmod 600 "$OUT"
gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASS" -o "$OUT.gpg" "$OUT"
ln -sfn "$(basename "$OUT.gpg")" "$D/latest.tgz.gpg"
ls -1t "$D"/station-*.tgz | tail -n +9 | xargs -r rm -f
ls -1t "$D"/station-*.tgz.gpg | tail -n +9 | xargs -r rm -f
logger -t royalhome-backup "ok $KIND $OUT $(du -h "$OUT" | cut -f1)"
echo "ok $KIND $OUT $(du -h "$OUT" | cut -f1)"
