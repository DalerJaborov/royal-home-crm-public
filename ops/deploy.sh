#!/usr/bin/env bash
# ВЫКАТ CRM НА ПРОД — ОДИН ИСТОЧНИК ПРАВДЫ (27.08.2026, совет экспертов, п. 12).
#
# Зачем скрипт, если есть «три команды». Их не три: за месяц рецепт оброс
# граблями, каждая из которых стоила простоя, и все они жили в голове того, кто
# выкатывает, да в мёртвом workflow (минуты GitHub Actions кончились в июле).
# Здесь они собраны и выполняются всегда, а не когда вспомнишь:
#
#   • только docker-compose.prod.yml. Добавленный «-f docker-compose.yml» 19 дней
#     подряд поднимал прод с настройками разработки — база смотрела наружу;
#   • ТРИ контейнера, а не один: api + worker (кроны, Telegram, ARI) + web;
#   • web пересобирается вместе с api. nginx резолвит имя api при старте, и
#     после пересоздания api он держал мёртвый IP — вся CRM отвечала 502
#     (резолвер починен 27.08, но пересборка web всё равно нужна: в неё впекается
#     фронтенд-сборка и ключ карт);
#   • health проверяется ПОСЛЕ выката, а не «на глаз», и код возврата честный:
#     провал health — провал выката, скрипт выходит с ошибкой;
#   • миграции применяет сам контейнер при старте (CMD в apps/api/Dockerfile),
#     здесь мы лишь убеждаемся, что база «up to date».
#
# Запуск НА СЕРВЕРЕ из каталога репозитория:
#   ./ops/deploy.sh              # полный выкат (api + worker + web)
#   ./ops/deploy.sh api          # только бэкенд (web всё равно перезапустится)
#   ./ops/deploy.sh --no-pull    # выкатить то, что уже лежит в рабочем дереве
#   ./ops/deploy.sh api --sha=<40 hex>  # выкатить ровно этот коммит (так зовёт тик auto-deploy.sh)
set -u -o pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
COMPOSE="docker compose --env-file $REPO_DIR/.env.production -f $REPO_DIR/docker-compose.prod.yml"
# СВОЙ BOT API СЕРВЕР — рубильник тот же, что в telegram/api.ts (пусто = облако,
# заполнено = локальный режим): если он включён, ОБЯЗАН ехать вторым файлом на
# КАЖДОМ выкате. Без него api/worker пересоздаются без volume telegram_bot_api_data
# (ops/telegram-local-botapi.md §6), getFile продолжает отдавать абсолютные пути
# ("--local"), но читать их изнутри контейнера уже нечем — ENOENT, вложения
# клиентов и готовые ролики от монтажёра молча перестают приниматься. Найдено
# 16.09.2026: обычный ./ops/deploy.sh без этой строки тихо ломал приём видео от
# монтажёра при каждом обычном выкате после первого ручного переключения.
if grep -qE '^TELEGRAM_API_BASE_URL=\S+' "$REPO_DIR/.env.production" 2>/dev/null; then
  COMPOSE="$COMPOSE -f $REPO_DIR/docker-compose.telegram.yml"
fi
# ── ВЫКАТЫ ИДУТ СТРОГО ПО ОДНОМУ, ОТКУДА БЫ ИХ НИ ЗАПУСТИЛИ (19.09.2026) ─────
# Путей выката стало два: GitHub Actions (deploy.yml) и таймер на самом сервере
# (ops/auto-deploy.sh, он появился после того, как 15.09 Actions встали на четыре
# дня). Очередь `concurrency: deploy-vps` в deploy.yml придерживает только свои
# прогоны и о таймере не знает вовсе. Наехавшие друг на друга выкаты — это
# «Conflict. The container name … is already in use», контейнеры в состоянии
# Created и 502 снаружи: ровно то, что разбирали 11.08.2026 (11 упавших выкатов
# из 30). Общий файловый замок — единственное, что видят ОБА пути.
#
# Ждём, а не выходим с ошибкой: второй выкат должен поехать следом, а не пропасть.
DEPLOY_LOCK="${CRM_DEPLOY_LOCK:-/var/lock/royalhome-deploy.lock}"
DEPLOY_LOCK_WAIT="${CRM_DEPLOY_LOCK_WAIT:-900}"
if [ "${CRM_DEPLOY_LOCK_HELD:-0}" != "1" ] && command -v flock >/dev/null 2>&1; then
  if exec 8>"$DEPLOY_LOCK" 2>/dev/null; then
    if ! flock -w "$DEPLOY_LOCK_WAIT" 8; then
      echo "[deploy][ОШИБКА] другой выкат идёт дольше ${DEPLOY_LOCK_WAIT}с — не ждём дальше" >&2
      exit 1
    fi
  else
    echo "[deploy][WARN] не смог открыть $DEPLOY_LOCK — выкат идёт без замка" >&2
  fi
fi

# Какой коммит реально доехал до зелёного health. Файл ведут ОБА пути выката, а
# читает его ops/auto-deploy.sh, решая «пора или не пора». Без него выкат из
# GitHub Actions был бы для таймера невидим, и таймер выкатывал бы то же самое
# по второму разу.
DEPLOYED_SHA_FILE="${CRM_AUTODEPLOY_STATE_DIR:-/var/lib/royalhome-auto-deploy}/deployed-sha"

HEALTH_URL="${CRM_HEALTH_URL:-http://127.0.0.1:8080/api/v1/health}"
# Сколько ждём, пока поднявшийся api начнёт отвечать: миграции на старте иногда
# идут секунды, и мгновенная проверка ловила бы ещё не проснувшийся контейнер.
HEALTH_TRIES=20
HEALTH_DELAY=3

WHAT="all"
DO_PULL=1
# --sha=<40 hex> — выкатить РОВНО этот коммит (его передаёт тик auto-deploy.sh: он
# проверил Ship-Verified и выбрал цель по diff именно для него). Без этого ключа
# deploy.sh делал свой `git pull` и собирал то, что окажется в main к этому
# моменту, а проверка тика к нему уже не относилась (аудит Codex 04.10, OPS-01).
PIN_SHA=""
for arg in "$@"; do
  case "$arg" in
    api|web|all) WHAT="$arg" ;;
    --no-pull) DO_PULL=0 ;;
    --sha=*)
      PIN_SHA="${arg#--sha=}"
      case "$PIN_SHA" in
        *[!0-9a-f]*|"") echo "--sha= принимает полный хеш коммита (40 символов 0-9a-f)" >&2; exit 2 ;;
      esac
      [ "${#PIN_SHA}" = "40" ] || { echo "--sha= принимает полный хеш коммита (40 символов 0-9a-f)" >&2; exit 2; }
      ;;
    *) echo "Не понимаю аргумент: $arg (ожидается api|web|all|--no-pull|--sha=<хеш>)" >&2; exit 2 ;;
  esac
done

say() { echo "[deploy] $*"; }
die() { echo "[deploy][ОШИБКА] $*" >&2; exit 1; }

# ── 0. Гейт: база не должна торчать наружу ──────────────────────────────────
# Пункт 7 аудита безопасности 11.09.2026 (К3): docker-compose.prod.yml сегодня
# не публикует порт postgres на хост вообще (сервис виден api/worker только
# по внутреннему имени `postgres:5432` внутри docker-сети) — и ЭТО и есть
# правильное состояние. Проверяем его на каждом выкате, а не полагаемся, что
# так и останется: одна случайная строка `ports: ["5432:5432"]` в будущей
# правке — и база Client/Deal видна всему интернету молча, до первого разбора
# инцидента. Проверяем и до, и после перезапуска: "до" ловит уже текущее
# состояние (кто-то мог поднять руками), "после" — саму эту правку деплоя.
guard_postgres_not_exposed() {
  local ps_output
  ps_output="$($COMPOSE ps postgres 2>/dev/null || true)"
  if echo "$ps_output" | grep -qE '0\.0\.0\.0:5432|:::5432'; then
    die "postgres опубликован на 0.0.0.0:5432 — база видна снаружи. Выкат остановлен, правь docker-compose.prod.yml (не должно быть ports: для postgres, либо только 127.0.0.1:5432:5432)."
  fi
}
guard_postgres_not_exposed

# ── 1. Свежий код ────────────────────────────────────────────────────────────
if [ -n "$PIN_SHA" ]; then
  # Замок уже взят выше, так что дерево больше никто не двигает. fetch не нужен:
  # тик забрал origin до проверки, и объект коммита уже локально.
  say "ставим дерево на проверенную вершину ${PIN_SHA:0:8}"
  git merge --ff-only --quiet "$PIN_SHA" || die "дерево не продвигается до ${PIN_SHA:0:8} (правки прямо на сервере или такого коммита нет? см. git status)"
  HEAD_NOW="$(git rev-parse HEAD)"
  if [ "$HEAD_NOW" != "$PIN_SHA" ]; then
    # Пока мы ждали замок, другой выкат (Actions) подтянул main дальше. Собрать
    # HEAD по проверке чужого коммита нельзя, откатывать дерево назад тоже. Код 3
    # — «не авария»: тик не считает его падением, следующий решит заново.
    say "в дереве уже ${HEAD_NOW:0:8}, а проверяли ${PIN_SHA:0:8}: этот выкат уступает, следующий тик решит заново"
    exit 3
  fi
elif [ "$DO_PULL" = "1" ]; then
  say "тянем main"
  # ff-only: слияние на проде означает, что кто-то правил файлы прямо здесь, —
  # это надо увидеть и разобрать руками, а не заметать коммитом слияния.
  git pull --ff-only || die "git pull не прошёл (правки прямо на сервере? см. git status)"
fi
say "выкатываем $(git log --oneline -1)"

# ── 1.1 Общая сеть royalhome-shared (аудит Codex 04.10, OPS-04) ──────────────
# docker-compose.prod.yml объявляет её external: true, то есть compose её сам не
# создаёт, а без неё api/worker не стартуют («network … declared as external, but
# could not be found»). На действующем VPS сеть уже есть; на чистом хосте её не
# было нигде. Идемпотентно: inspect, и только если сети нет — create. Отказ
# создания не валит выкат: compose следом назовёт настоящую причину сам.
docker network inspect royalhome-shared >/dev/null 2>&1 \
  || docker network create royalhome-shared >/dev/null 2>&1 \
  || say "ВНИМАНИЕ: сеть royalhome-shared не создана — compose не поднимет api/worker"

# ── 1.5. Логи уходящих контейнеров ──────────────────────────────────────────
# TASKS.md ~594 (09.09): ротация json-file (max-size/max-file в docker-compose.prod.yml)
# спасает от разросшегося лога, но НЕ от потери — `docker compose up -d` после
# `build` пересоздаёт контейнер (новый id), а json-логи лежат в
# /var/lib/docker/containers/<id>/*.log и уезжают вместе со старым контейнером.
# Инцидент 09.09 05:30–06:57 расследовать было нечем именно поэтому. Копируем
# «хвост» лога КАЖДОГО живого контейнера на диск хоста (вне git, вне контейнера)
# ДО пересборки — тогда причина зависания переживает деплой, даже если сам
# контейнер снесён.
DEPLOY_LOGS_DIR="${CRM_DEPLOY_LOGS_DIR:-/backups/crm-deploy-logs}"
DEPLOY_LOGS_KEEP_DAYS="${CRM_DEPLOY_LOGS_KEEP_DAYS:-14}"
mkdir -p "$DEPLOY_LOGS_DIR" 2>/dev/null || true
if [ -d "$DEPLOY_LOGS_DIR" ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  for name in $(docker ps --filter "name=royalhome-crm" --format '{{.Names}}'); do
    docker logs --since 48h "$name" > "$DEPLOY_LOGS_DIR/${name}-$STAMP.log" 2>&1 || true
  done
  find "$DEPLOY_LOGS_DIR" -name '*.log' -mtime "+$DEPLOY_LOGS_KEEP_DAYS" -delete 2>/dev/null || true
else
  say "ВНИМАНИЕ: $DEPLOY_LOGS_DIR недоступен для записи — логи уходящих контейнеров не сохранены"
fi

# ── 2. Сборка ────────────────────────────────────────────────────────────────
# Образ api собирается один раз и переиспользуется контейнером worker (у него в
# compose стоит image, а не build) — пересобирать его отдельно не нужно.
case "$WHAT" in
  all) BUILD_TARGETS="api web" ;;
  api) BUILD_TARGETS="api" ;;
  web) BUILD_TARGETS="web" ;;
esac
say "сборка образов: $BUILD_TARGETS"
# По одному образу, а не разом (08.10.2026): на сервере 6 ГБ, и параллельная
# сборка web (vite) вместе с tsc api уронила tsc по памяти — выкат f030092c
# упал трижды «JavaScript heap out of memory».
for target in $BUILD_TARGETS; do
  $COMPOSE build "$target" || die "сборка образа $target не удалась — прод не тронут"
done

# ── 2.5. Миграции ДО пересоздания контейнеров (fix/deploy-no-downtime, 22.09.2026) ──
# Раньше миграции применялись только внутри CMD нового api-контейнера
# (`npm run prisma:migrate:deploy && exec node dist/index.js`) — то есть уже
# ПОСЛЕ того, как старый контейнер остановлен, а новый ещё не слушает порт.
# Весь ход миграции (идемпотентно применяет только новые — обычно доли
# секунды, но при крупной миграции может быть заметно дольше) ложился
# ровно в окно недоступности. Прогоняем её здесь одноразовым контейнером
# из уже собранного образа, пока старые api/worker ещё работают и отвечают:
# к моменту `up -d` ниже миграция уже применена, и CMD нового контейнера
# найдёт "no pending migrations" и стартует почти мгновенно. Идемпотентно и
# безопасно при наложении с миграцией внутри CMD (Prisma сама берёт advisory
# lock на схему). Только когда трогаем api/worker — для web миграции не нужны.
if [ "$WHAT" != "web" ]; then
  say "миграции (одноразовым контейнером, до перезапуска)"
  $COMPOSE run --rm --no-deps api npm run prisma:migrate:deploy \
    || die "миграции не применились — контейнеры не тронуты"
fi

# ── 3. Перезапуск ────────────────────────────────────────────────────────────
# Порядок «api/worker раньше web» теперь обеспечивает сам compose:
# docker-compose.prod.yml даёт web `depends_on: api: condition: service_healthy`
# (свой healthcheck у api) — даже единый `up -d api worker web` ниже сначала
# дожидается зелёного health api и только потом трогает web. Раньше `depends_on`
# у web был простым списком («api хотя бы запущен»), и web пересоздавался
# почти одновременно с api — секунды до первого ответа api и были окном 502
# (три выката подряд 08:42-08:48 22.09.2026, 146 таких ответов).
# worker поднимается всегда вместе с api: у них общий образ, и оставить старый
# worker с новым api значит развести версии кода в одном проде.
# ПРИ ПРАВКЕ ТОЛЬКО API NGINX НЕ ТРОГАЕМ (19.09.2026).
#
# Здесь стояло `api) UP_TARGETS="api worker web"` — то есть любой выкат
# бэкенда пересоздавал и контейнер web. А web — это раздача самого приложения:
# пока он поднимается, браузер не получает ни страницы, ни её файлов, и лежит
# НЕ часть CRM, а вся. Ровно это владелец и видел 19.09 как «то дашборд не
# грузится, то чаты»: контейнеры были подняты за минуты до жалобы, а в журнале
# API ни одной ошибки.
#
# Пересоздавать web ради выката api и не нужно: `resolver 127.0.0.11 valid=10s`
# в apps/web/nginx.conf (аудит №4, 27.08) как раз и добавлен для того, чтобы
# nginx перерезолвивал `api:4000` сам и переживал смену IP контейнера. Ради
# этого свойства он и живёт — а прежняя строка его обнуляла.
#
# Теперь при `deploy.sh api` наружу остаётся только окно, пока не поднялся сам
# api: страница и её файлы отдаются всё это время, а запросы к API повторяет
# клиент (lib/queryClient.ts).
case "$WHAT" in
  all) UP_TARGETS="api worker web" ;;
  api) UP_TARGETS="api worker" ;;
  web) UP_TARGETS="web" ;;
esac
say "перезапуск: $UP_TARGETS"
$COMPOSE up -d $UP_TARGETS || die "контейнеры не поднялись"
guard_postgres_not_exposed

# ── 4. Проверки ──────────────────────────────────────────────────────────────
say "ждём health"
ok=0
for _ in $(seq "$HEALTH_TRIES"); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || echo 000)"
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep "$HEALTH_DELAY"
done
[ "$ok" = "1" ] || die "health не ответил 200 за $((HEALTH_TRIES * HEALTH_DELAY))с — смотри docker logs"

# 401 на закрытом роуте — признак, что жива не только заглушка health, но и
# связка «маршруты + база»: неотвечающая база дала бы 503.
clients_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${HEALTH_URL%/health}/clients" || echo 000)"
[ "$clients_code" = "401" ] || say "ВНИМАНИЕ: /clients ответил $clients_code (ожидался 401) — проверь базу"

say "миграции:"
$COMPOSE exec -T api npx prisma migrate status 2>&1 | grep -aE "up to date|pending|failed" || true

say "контейнеры:"
docker ps --filter "name=royalhome-crm" --format '  {{.Names}} — {{.Status}}'

mkdir -p "$(dirname "$DEPLOYED_SHA_FILE")" 2>/dev/null || true
git rev-parse HEAD > "$DEPLOYED_SHA_FILE" 2>/dev/null || true

say "готово: $(git log --oneline -1)"

# ── 5. Уборка старых образов (02.10.2026, диск 85%) ─────────────────────────
# Каждый выкат собирает новые образы api/web под тем же именем, а прежние
# остаются на диске безымянными (<none>) вместе с кэшем сборки — по десятку
# выкатов в день это гигабайты в неделю, и до этой строки их не убирал никто.
# Только ПОСЛЕ проверок выше: новый контейнер уже работает. `image prune` без
# `-a` берёт лишь безымянные образы и не трогает те, на которых что-то
# запущено; кэш сборки моложе недели оставляем, чтобы выкаты не стали дольше.
# Отказ уборки выкат не валит.
docker image prune -f >/dev/null 2>&1 || say "ВНИМАНИЕ: уборка старых образов не удалась"
docker builder prune -f --filter "until=168h" >/dev/null 2>&1 || say "ВНИМАНИЕ: уборка кэша сборки не удалась"
say "диск после уборки: $(df -h / | awk 'NR==2 {print $5 " занято, свободно " $4}')"
