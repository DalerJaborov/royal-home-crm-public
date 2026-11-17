#!/usr/bin/env bash
# Общее для скриптов шлюза WhatsApp (подключается через `.`, сам не запускается).
#
#  - WA_HOME — установленная копия на сервере (вне /opt/royalhome-crm: автовыкат
#    встаёт, если в каталоге репозитория изменён отслеживаемый файл, а cron шлюза
#    должен работать независимо от выкатов — тот же приём, что ops/pbx/vps).
#  - wa_run — выполнить команду или, при --dry-run, только показать её.
#  - wa_graph — ЕДИНСТВЕННАЯ дверь к Graph API Meta: ключ WhatsApp берётся внутри
#    контейнера CRM (worker) её же загрузчиком loadCredentials и наружу не выходит.

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
WA_HOME="${WA_HOME:-/opt/royalhome-wa-gateway}"
WA_ENV_FILE="${WA_ENV_FILE:-$WA_HOME/gateway.env}"
WA_CONTAINER="${WA_CONTAINER:-royalhome-wa-gateway}"
WA_IMAGE="${WA_IMAGE:-royalhome-wa-gateway:local}"
CRM_DIR="${CRM_DIR:-/opt/royalhome-crm}"
DRY_RUN="${DRY_RUN:-0}"

wa_log() { printf '[%s] %s\n' "$(basename "$0")" "$*"; }
wa_die() { printf '[%s] ОШИБКА: %s\n' "$(basename "$0")" "$*" >&2; exit 1; }

# Разбор общих флагов. Скрипт зовёт: wa_parse_common "$@"; set -- "${WA_ARGS[@]}"
wa_parse_common() {
  WA_ARGS=()
  local a
  for a in "$@"; do
    case "$a" in
      --dry-run) DRY_RUN=1 ;;
      *) WA_ARGS+=("$a") ;;
    esac
  done
  if [ "$DRY_RUN" = "1" ]; then wa_log "РЕЖИМ --dry-run: ничего не меняется, команды только печатаются"; fi
}

wa_run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# Настройки шлюза. В --dry-run без файла берутся значения из примера рядом со
# скриптом — чтобы план можно было посмотреть до установки.
wa_load_env() {
  local f="$WA_ENV_FILE"
  if [ ! -f "$f" ]; then
    if [ "$DRY_RUN" = "1" ] && [ -f "$(dirname "$0")/../gateway.env.example" ]; then
      f="$(dirname "$0")/../gateway.env.example"
      wa_log "нет $WA_ENV_FILE — для плана беру пример $f"
    else
      wa_die "нет $WA_ENV_FILE (сначала wa-install.sh)"
    fi
  fi
  set -a
  # shellcheck disable=SC1090
  . "$f"
  set +a
}

wa_require_root() {
  if [ "$DRY_RUN" != "1" ] && [ "$(id -u)" != "0" ]; then wa_die "запускать от root (sudo)"; fi
}

# Тревога в Telegram тем же путём, что бэкапы и сторожа CRM (ops/lib.sh).
wa_alert() {
  local text="$1"
  if [ -f "$CRM_DIR/ops/lib.sh" ]; then
    # shellcheck source=/dev/null
    . "$CRM_DIR/ops/lib.sh"
    crm_telegram_alert "WhatsApp-шлюз: $text" || true
  else
    wa_log "тревога (ops/lib.sh не найден): $text" >&2
  fi
}

# Контейнер worker CRM — в нём есть собранный код CRM и доступ к базе с ключами.
wa_crm_worker() {
  docker ps --filter "label=com.docker.compose.project=royalhome-crm" \
    --filter "label=com.docker.compose.service=worker" --format '{{.Names}}' | head -n1
}

# wa_graph <op> — вызов Graph API изнутри CRM. stdout — результат операции,
# stderr — сообщения. Ключ в вывод не попадает (graph-call.mjs).
wa_graph() {
  local op="$1" worker
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] docker exec -i -e WA_OP=%s -e WA_PHONE_ID=%s -e WA_SIP_HOST=%s -e WA_TLS_PORT=%s <worker CRM> node --input-type=module - < %s/graph-call.mjs\n' \
      "$op" "${WA_PHONE_ID:-?}" "${WA_SIP_HOST:-?}" "${WA_TLS_PORT:-5061}" "$script_dir"
    if command -v node >/dev/null 2>&1; then
      (cd "$script_dir" && WA_OP="$op" WA_DESCRIBE_ONLY=1 WA_SIP_HOST="${WA_SIP_HOST:-}" \
        WA_TLS_PORT="${WA_TLS_PORT:-5061}" WA_TEST_TO="${WA_TEST_TO:-}" \
        node --input-type=module - < graph-call.mjs) || true
    else
      printf '  [dry-run] (тело запроса: graph-call.mjs, операция %s; node на хосте нет — не показываю)\n' "$op"
    fi
    return 0
  fi
  worker="$(wa_crm_worker)"
  [ -n "$worker" ] || wa_die "контейнер worker CRM не найден (docker ps)"
  docker exec -i \
    -e WA_OP="$op" -e WA_PHONE_ID="${WA_PHONE_ID:?}" \
    -e WA_SIP_HOST="${WA_SIP_HOST:?}" -e WA_TLS_PORT="${WA_TLS_PORT:-5061}" \
    -e WA_TEST_TO="${WA_TEST_TO:-}" \
    "$worker" node --input-type=module - < "$script_dir/graph-call.mjs"
}
