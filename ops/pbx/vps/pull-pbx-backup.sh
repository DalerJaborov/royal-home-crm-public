#!/usr/bin/env bash
# Забирает ночную зашифрованную копию станции FreePBX через обратный туннель (127.0.0.1:2222,
# ключ /root/.ssh/royalhome_pbx_pull с forced command на станции) → /backups/pbx → R2.
# Cron на VPS: 40 3 * * * /opt/royalhome-pbx/pull-pbx-backup.sh >> /var/log/pbx-backup.log 2>&1
# Копия проверяется расшифровкой и чтением оглавления tar перед тем, как считаться снятой.
# Алерт — тот же Telegram, что у бэкапов CRM (ops/lib.sh → /opt/watchdog.env). 08.10.2026.
set -u -o pipefail
if [ -r /opt/royalhome-crm/ops/lib.sh ]; then . /opt/royalhome-crm/ops/lib.sh; fi
type alert >/dev/null 2>&1 || alert(){ echo "ALERT: $*" >&2; }
DEST=/backups/pbx; mkdir -p "$DEST"
KEY=/root/.ssh/royalhome_pbx_pull
PASS=/root/.royalhome-pbx-backup-pass
SSH="ssh -p 2222 -i $KEY -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@127.0.0.1"
NAME=$($SSH name 2>/dev/null) || { alert "PBX backup: станция не отдала имя копии (туннель 2222 лежит?)"; exit 1; }
[ -n "$NAME" ] || { alert "PBX backup: станция вернула пустое имя копии"; exit 1; }
if [ -s "$DEST/$NAME" ]; then echo "[pbx-backup] уже есть $NAME"; exit 0; fi
TMP="$DEST/.$NAME.part"
$SSH latest > "$TMP" || { rm -f "$TMP"; alert "PBX backup: не удалось скачать $NAME"; exit 1; }
[ "$(stat -c%s "$TMP")" -gt 10000 ] || { rm -f "$TMP"; alert "PBX backup: копия $NAME подозрительно мала"; exit 1; }
if ! gpg --batch --quiet --passphrase-file "$PASS" --decrypt "$TMP" 2>/dev/null | tar tzf - >/dev/null; then
  rm -f "$TMP"; alert "PBX backup: архив $NAME не расшифровывается или не читается"; exit 1
fi
mv "$TMP" "$DEST/$NAME"
find "$DEST" -name 'station-*.tgz.gpg' -mtime +30 -delete
if command -v rclone >/dev/null 2>&1; then
  rclone copy "$DEST/$NAME" r2:royalhome-backups/pbx/ --s3-no-check-bucket \
    || alert "PBX backup: оффсайт в R2 не удался (локальная копия $NAME цела)"
fi
echo "[pbx-backup] OK $NAME $(du -h "$DEST/$NAME" | cut -f1)"
