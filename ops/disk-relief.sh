#!/usr/bin/env bash
# Ограничивает число ЛОКАЛЬНЫХ копий (хендофф 12.09: 9 ГБ копий лежат на том
# же сервере, что и рабочая база, — при заполнении диска это бьёт по тому же
# хосту, который копии должны спасать).
#
# Отличается от ротации в backup.sh: там `find -mtime +$KEEP_DAYS -delete` —
# по ВОЗРАСТУ (сейчас 30 дней). Здесь — по КОЛИЧЕСТВУ последних копий каждого
# вида, независимо от возраста, потому что оффсайт (R2, шаг 4 в backup.sh) уже
# хранит копии 180 дней — локально столько держать незачем и дорого по диску.
# Использовать ОБА правила одновременно безопасно: удаляется то, что попадает
# под любое из них, лишь бы файл уже уехал оффсайт (проверяем по логу rclone
# не можем — вместо этого держим запас: N локальных копий всегда покрывает
# время, за которое offsite точно успел забрать более старые).
#
# Запуск на VPS раз в сутки, после backup.sh:
#   crontab -e  →  30 3 * * * /bin/bash /opt/royalhome-crm/ops/disk-relief.sh >> /var/log/crm-backup.log 2>&1
# (через /bin/bash: до 25.09 файл лежал в git без права на запуск, и строка
# без него в crontab молча не срабатывала.)
#
# Видео объектов — отдельный лимит (25.09.2026): архив каждый день ПОЛНЫЙ и
# вырос до 6 ГБ; 7 таких копий — 40 ГБ на диске в 77 ГБ, диск забился до 93%.
# Оффсайт хранит все, локально хватает двух.
set -u -o pipefail

BACKUP_DIR="${CRM_BACKUP_DIR:-/backups/crm}"
KEEP_LOCAL="${CRM_BACKUP_KEEP_LOCAL:-7}"
KEEP_LOCAL_VIDEO="${CRM_BACKUP_KEEP_LOCAL_VIDEO:-2}"

for pair in "CRM_BACKUP_KEEP_LOCAL=$KEEP_LOCAL" "CRM_BACKUP_KEEP_LOCAL_VIDEO=$KEEP_LOCAL_VIDEO"; do
  if ! [ "${pair#*=}" -gt 0 ] 2>/dev/null; then
    echo "[disk-relief][ERROR] ${pair%%=*} должен быть положительным числом, получено: ${pair#*=}" >&2
    exit 2
  fi
done

[ -d "$BACKUP_DIR" ] || { echo "[disk-relief] $BACKUP_DIR не существует — нечего чистить"; exit 0; }

# Каждый вид архива (db, uploads, private-uploads, property-video, deal-docs) чистим
# отдельно по своему счётчику — иначе всплеск одного вида (например, видео)
# вытеснит из локального хранилища дампы базы, которые легче всего просто взять
# и проверить restore-drill.sh.
TOTAL_REMOVED=0
for prefix in crm-db crm-uploads crm-private-uploads crm-property-video crm-deal-docs; do
  # Сортировка по имени работает, потому что STAMP=$(date +%F) в backup.sh
  # даёт лексикографический порядок = хронологический (YYYY-MM-DD).
  mapfile -t files < <(find "$BACKUP_DIR" -maxdepth 1 -name "${prefix}-*.gz" -printf '%f\n' 2>/dev/null | sort)
  count="${#files[@]}"
  keep="$KEEP_LOCAL"
  [ "$prefix" = "crm-property-video" ] && keep="$KEEP_LOCAL_VIDEO"
  if [ "$count" -le "$keep" ]; then
    continue
  fi
  to_remove=$(( count - keep ))
  for ((i = 0; i < to_remove; i++)); do
    echo "[disk-relief] удаляю локальную копию: ${files[$i]} (оставляем последние $keep вида $prefix, во внешнем хранилище остаётся)"
    rm -f "$BACKUP_DIR/${files[$i]}"
    TOTAL_REMOVED=$((TOTAL_REMOVED + 1))
  done
done

echo "[disk-relief] OK: удалено $TOTAL_REMOVED файлов, локально осталось до $KEEP_LOCAL копий на каждый вид (видео — до $KEEP_LOCAL_VIDEO) в $BACKUP_DIR"
