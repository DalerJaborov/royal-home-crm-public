#!/usr/bin/env bash
# Подъём Royal Home CRM с нуля на чистом Ubuntu — хендофф 12.09: сейчас на это
# уходит около 6 часов (по памяти, шаг за шагом руками), нужен час.
#
# IDEMPOTENT: каждую секцию можно запускать повторно — она сама проверяет,
# что уже сделано, и пропускает шаг. Так безопасно перезапустить скрипт после
# сбоя посередине, не разбирая руками, что уже поднялось.
#
# Использование:
#   sudo ./ops/bootstrap.sh --deploy-key /root/.ssh/crm_deploy_ed25519 \
#     [--repo-url git@github.com:DalerJaborov/royal-home-crm-public.git] \
#     [--repo-dir /opt/royalhome-crm] \
#     [--restore-from /backups/crm/crm-db-2026-09-10.sql.gz]
#
# Без --restore-from база поднимается ПУСТОЙ (миграции применит сам контейнер
# api при первом старте, см. apps/api/Dockerfile). С --restore-from скрипт
# восстанавливает указанную копию ЧЕРЕЗ ops/restore-drill.sh --into-prod —
# то есть только по явному флагу, никогда сам по себе.
set -u -o pipefail

say() { echo "[bootstrap] $*"; }
die() { echo "[bootstrap][ОШИБКА] $*" >&2; exit 1; }

REPO_URL="git@github.com:DalerJaborov/royal-home-crm-public.git"
REPO_DIR="/opt/royalhome-crm"
DEPLOY_KEY=""
RESTORE_FROM=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --deploy-key) DEPLOY_KEY="${2:-}"; shift 2 ;;
    --repo-url) REPO_URL="${2:-}"; shift 2 ;;
    --repo-dir) REPO_DIR="${2:-}"; shift 2 ;;
    --restore-from) RESTORE_FROM="${2:-}"; shift 2 ;;
    *) die "неизвестный аргумент: $1" ;;
  esac
done

[ -n "$DEPLOY_KEY" ] || die "нужен --deploy-key <путь к приватному SSH-ключу деплоя>"
[ -f "$DEPLOY_KEY" ] || die "ключ $DEPLOY_KEY не найден"

# ── 1. Docker + compose plugin ──────────────────────────────────────────────
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  say "docker + compose plugin уже установлены, пропускаю"
else
  say "устанавливаю docker + compose plugin"
  curl -fsSL https://get.docker.com | sh || die "установка docker не удалась"
  systemctl enable --now docker || die "не удалось включить docker"
fi

# ── 2. Caddy ─────────────────────────────────────────────────────────────────
if command -v caddy >/dev/null 2>&1; then
  say "caddy уже установлен, пропускаю"
else
  say "устанавливаю caddy (официальный репозиторий)"
  apt-get update -y || die "apt-get update не удался"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg || die "не удалось поставить зависимости для репозитория caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y || die "apt-get update (caddy) не удался"
  apt-get install -y caddy || die "установка caddy не удалась"
fi

# ── 3. Клонирование репозитория по ключу деплоя ─────────────────────────────
if [ -d "$REPO_DIR/.git" ]; then
  say "$REPO_DIR уже клонирован, пропускаю (обновит ops/deploy.sh при выкате)"
else
  say "клонирую $REPO_URL в $REPO_DIR"
  mkdir -p "$(dirname "$REPO_DIR")"
  GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
    git clone "$REPO_URL" "$REPO_DIR" || die "git clone не удался"
fi
cd "$REPO_DIR" || die "не могу перейти в $REPO_DIR"

# ── 4. .env.production — требуем, НЕ создаём с секретами ───────────────────
if [ -f "$REPO_DIR/.env.production" ]; then
  say ".env.production уже на месте, пропускаю"
else
  say "не найден $REPO_DIR/.env.production — секреты руками, скрипт их не выдумывает."
  say "обязательные переменные (см. docker-compose.prod.yml, поля со знаком :?):"
  grep -oE '\$\{[A-Z0-9_]+:\?\}' "$REPO_DIR/docker-compose.prod.yml" | sed 's/[${}?:]//g' | sort -u | sed 's/^/  - /'
  die "создай $REPO_DIR/.env.production (см. .env.example) и запусти bootstrap.sh снова"
fi

# ── 5. crontab: backup, disk-watch, restore-drill ───────────────────────────
CRON_MARKER="# royalhome-crm bootstrap"
if crontab -l 2>/dev/null | grep -qF "$CRON_MARKER"; then
  say "crontab уже настроен, пропускаю"
else
  say "добавляю задания в crontab (backup 03:00, disk-relief 03:30, disk-watch каждые 15 мин, restore-drill воскресенье 04:00)"
  { crontab -l 2>/dev/null || true; cat <<CRON
$CRON_MARKER
0 3 * * * $REPO_DIR/ops/backup.sh >> /var/log/crm-backup.log 2>&1
30 3 * * * /bin/bash $REPO_DIR/ops/disk-relief.sh >> /var/log/crm-backup.log 2>&1
*/15 * * * * $REPO_DIR/ops/disk-watch.sh >> /var/log/crm-watch.log 2>&1
0 4 * * 0 $REPO_DIR/ops/restore-drill.sh >> /var/log/crm-restore-drill.log 2>&1
CRON
  } | crontab - || die "не удалось записать crontab"
fi

# ── 6. Caddyfile ─────────────────────────────────────────────────────────────
if [ -f /etc/caddy/Caddyfile ]; then
  say "/etc/caddy/Caddyfile уже существует, НЕ трогаю (см. память проекта — там могли быть точечные правки)"
else
  say "пишу /etc/caddy/Caddyfile из шаблона ops/Caddyfile.example"
  mkdir -p /etc/caddy/certs
  cp "$REPO_DIR/ops/Caddyfile.example" /etc/caddy/Caddyfile || die "не удалось скопировать Caddyfile"
  say "ВНИМАНИЕ: положи сертификат источника в /etc/caddy/certs/origin.crt|key (Origin CA Cloudflare — предпочтительно) перед запуском caddy"
fi

# ── 6.5. Общая сеть royalhome-shared ─────────────────────────────────────────
# docker-compose.prod.yml объявляет её external: true — compose её не создаёт, а
# без неё api/worker не стартуют на чистом хосте (аудит Codex 04.10, OPS-04).
# Идемпотентно: на хосте, где сеть уже есть, ничего не меняется.
docker network inspect royalhome-shared >/dev/null 2>&1 \
  || docker network create royalhome-shared >/dev/null \
  || die "не удалось создать docker-сеть royalhome-shared"

# ── 7. Восстановление базы (только по явному флагу) ─────────────────────────
if [ -n "$RESTORE_FROM" ]; then
  [ -f "$RESTORE_FROM" ] || die "файл копии $RESTORE_FROM не найден"
  say "поднимаю postgres перед восстановлением"
  docker compose -f "$REPO_DIR/docker-compose.prod.yml" --env-file "$REPO_DIR/.env.production" up -d postgres \
    || die "не удалось поднять postgres"
  say "восстанавливаю $RESTORE_FROM через ops/restore-drill.sh --into-prod"
  # bootstrap уже получил --restore-from явным флагом от оператора — второе
  # подтверждение внутри restore-drill.sh здесь избыточно.
  CONFIRM=yes "$REPO_DIR/ops/restore-drill.sh" --into-prod "$RESTORE_FROM" || die "восстановление базы не удалось"
else
  say "--restore-from не задан — база поднимется пустой, миграции применит контейнер api при первом старте"
fi

# ── 8. Выкат ──────────────────────────────────────────────────────────────────
say "запускаю ops/deploy.sh"
"$REPO_DIR/ops/deploy.sh" || die "deploy.sh не прошёл"

say "готово. Проверь: systemctl reload caddy (если Caddyfile менялся руками до этого), curl -sI https://crm.royalhome.tj/"
