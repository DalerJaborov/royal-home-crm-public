#!/usr/bin/env bash
# ВЫКАТ, КОТОРЫЙ НЕ ЗАВИСИТ ОТ GITHUB ACTIONS (19.09.2026).
#
# Зачем. Выкат на прод ездил только одним путём: GitHub Actions (deploy.yml) по
# завершении проверки. 15.09.2026 в 21:12 UTC GitHub перестал СОЗДАВАТЬ прогоны
# вообще — на каждый пуш заводится пустой прогон `BuildFailed` и гаснет за
# секунду, без единого задания. Падает всё разом: и ubuntu-latest, и свой раннер
# royalhome-vps (а он бесплатный), и ручной workflow_dispatch. Значит дело не в
# файлах потока и не в минутах на конкретном раннере, а в том, что Actions
# заглушены на уровне аккаунта.
#
# Последствие: с 15.09 20:25 по 19.09 на проде висел код четырёхдневной
# давности, при зелёных ветках и влитых PR. Снаружи это неотличимо от «выкатили,
# ничего не изменилось» — никто не заметил четыре дня.
#
# Это уже третий раз: в июле и 13-14.08.2026 выкат так же вставал из-за
# кончившихся минут (см. шапку ops/deploy.sh и ci.yml). Каждый раз чинили сам
# GitHub. Этот скрипт убирает GitHub из пути выката совсем: сервер сам смотрит
# на origin/main раз в минуту и выкатывается, когда ветка сдвинулась. Пока
# GitHub отдаёт `git fetch` — то есть всегда, когда работает git, — прод едет.
#
# Установка на сервере (один раз):  sudo ./ops/install-auto-deploy.sh
# Посмотреть, что делает:           systemctl status royalhome-auto-deploy.timer
#                                   journalctl -u royalhome-auto-deploy -n 100
# Выключить на время:               sudo systemctl stop royalhome-auto-deploy.timer
#
# Сам выкат делает ops/deploy.sh — один источник правды, тот же, которым
# выкатывают руками. Здесь только решение «пора или не пора».
set -u -o pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=ops/lib.sh
. "$REPO_DIR/ops/lib.sh"

BRANCH="${CRM_AUTODEPLOY_BRANCH:-main}"
STATE_DIR="${CRM_AUTODEPLOY_STATE_DIR:-/var/lib/royalhome-auto-deploy}"
# Замок ТИКА — не путать с замком самого выката (/var/lock/royalhome-deploy.lock,
# его берёт ops/deploy.sh). Этот следит только за тем, чтобы два тика таймера не
# наложились друг на друга.
LOCK_FILE="${CRM_AUTODEPLOY_LOCK:-/var/lock/royalhome-auto-deploy-tick.lock}"
# Сколько раз подряд пробовать ОДИН И ТОТ ЖЕ коммит, если выкат падает. Без
# потолка таймер каждую минуту сутки напролёт пересобирал бы образы на заведомо
# сломанном коммите и сыпал алертами; с потолком он отступает и ждёт следующего
# коммита — то есть починки.
MAX_TRIES="${CRM_AUTODEPLOY_MAX_TRIES:-4}"

say() { echo "[auto-deploy] $*"; }

# ── СКЛЕЙКА ПОДРЯД ИДУЩИХ ВЫКАТОВ (fix/deploy-no-downtime, 22.09.2026) ───────
# Раньше таймер выкатывал СРАЗУ на каждом тике, где origin/$BRANCH сдвинулся —
# то есть на каждый отдельный коммит, если пуши шли не одной пачкой. Измерено
# на проде: три выката подряд за 6 минут (08:42-08:48, 22.09.2026) дали 146
# ответов 502 — каждый выкат своё окно пересоздания api/web (сузили его в
# ops/deploy.sh/docker-compose.prod.yml/nginx.conf в этом же PR, но лучше не
# создавать окно три раза подряд без причины вовсе).
#
# Правило: выкатываем, когда вершина origin/$BRANCH не менялась QUIET_SECONDS
# подряд. Как только вершина сдвигается — таймер тишины сбрасывается на новый
# sha, и ждём заново. Состояние — файл "<sha> <unix-время-первого-появления>"
# рядом с остальными файлами состояния таймера.
#
# Функция вынесена отдельно и не трогает глобальные переменные — тестируется в
# изоляции: `CRM_AUTODEPLOY_SOURCE_ONLY=1 bash -c '. ops/auto-deploy.sh; …'`
# останавливает скрипт сразу после определения функций, не запуская git/flock/
# сетевые вызовы (см. флаг ниже, после определения функции).
QUIET_SECONDS="${CRM_AUTODEPLOY_QUIET_SECONDS:-600}"

# Возвращает 0 ("тихо", можно выкатывать) или 1 ("подождать ещё" — либо таймер
# только что сброшен на новый sha, либо время тишины не набралось). Не решает
# сама, выкатывать ли, — только считает время; отдушину [deploy-now] и
# FIRST_RUN проверяет вызывающий код.
crm_quiet_period_ok() {
  local remote="$1" quiet_file="$2" quiet_seconds="$3" now="$4"
  local saved sha ts elapsed
  saved="$(cat "$quiet_file" 2>/dev/null || true)"
  sha="${saved%% *}"
  ts="${saved#* }"
  if [ -z "$sha" ] || [ "$sha" = "$saved" ] || [ "$sha" != "$remote" ]; then
    # Нет записи, запись повреждена (нет пробела — sha=saved целиком), или
    # вершина сдвинулась дальше — таймер начинается заново на этом sha.
    printf '%s %s\n' "$remote" "$now" > "$quiet_file"
    return 1
  fi
  case "$ts" in
    ''|*[!0-9]*) printf '%s %s\n' "$remote" "$now" > "$quiet_file"; return 1 ;;
  esac
  elapsed=$((now - ts))
  [ "$elapsed" -ge "$quiet_seconds" ]
}

# ── НА САЙТ ТОЛЬКО ПРОВЕРЕННОЕ КОМАНДОЙ ВЫКАТА (24.09.2026, выбор Dan) ────────
# Правило владельца: в main — только через `npm run ship` (docs/ship.md). Команда
# вливает правку squash-коммитом, в сообщении которого строка
#   Ship-Verified: tree=<дерево проверенного коммита> main=<sha> api-tests=<N> failed=0
# Дерево коммита — это побайтно всё его содержимое, поэтому совпадение `tree=` с
# настоящим деревом вершины означает: на сайт едет ровно то, что проверено.
# Коммит без строки (влили кнопкой, из чата мимо команды) сервер НЕ выкатывает:
# сайт остаётся на последнем выкаченном, а следующий `npm run ship` проверит
# дерево уже вместе с этим коммитом и выкатит обоих.
#
# Почему на сервере, а не защитой ветки на GitHub: отметку GitHub (commit status)
# облачные сессии Claude ставить не могут — их прокси запрещает запись в
# /statuses и /check-runs (403, проверено 24.09). Сервер проверяет строку сам,
# от GitHub не зависит и одинаково работает для проекта, ноутбука и другой учётки.
#
# Снять на время (разбор руками на сервере): CRM_AUTODEPLOY_SHIP_GATE=0.
crm_ship_verified() { # crm_ship_verified <sha> — 0, если вершина влита командой ship
  local sha="$1" tree msg
  tree="$(git rev-parse "${sha}^{tree}" 2>/dev/null)" || return 1
  [ -n "$tree" ] || return 1
  msg="$(git log -1 --pretty=%B "$sha" 2>/dev/null)" || return 1
  printf '%s\n' "$msg" | grep -Eq "^Ship-Verified: tree=${tree}( |\$)"
}

# ── ВЫКАТ НЕ РВЁТ ЖИВОЙ РАЗГОВОР РОБОТА (02.10.2026, аудит фона №2) ──────────
# Мост живого голоса живёт в контейнере api, а расшифровка, итог, запись и
# onFinished сценария (приглашение на собеседование, опрос после показа,
# проверка продавца) уходят в базу ТОЛЬКО по концу разговора. Выкат с
# пересозданием api посреди звонка — человек слышит тишину, итога нет, а
# кандидату через час звонят второй раз. Поэтому тик выката ждёт, пока в базе
# есть незакрытая LiveVoiceSession моложе LIVE_CALL_WINDOW_MIN минут: потолок
# разговора в мосте 15 минут (LIVE_VOICE_MAX_SESSION_MS), строка старше —
# осиротевшая после прошлого рестарта и выкат не держит.
#
# Цель `web` api не трогает — её не держим. Запрос не удался (база лежит,
# контейнера нет, psql не тот) — выкатываем как раньше и пишем строку в журнал:
# выкат, вставший навсегда из-за сломанной проверки, хуже оборванного звонка.
# Снять на время: CRM_AUTODEPLOY_LIVE_CALL_GATE=0.
LIVE_CALL_WINDOW_MIN="${CRM_AUTODEPLOY_LIVE_CALL_WINDOW_MIN:-16}"

crm_live_voice_calls_query() { # печатает число идущих разговоров робота; код ≠0 — запрос не удался
  local pg_user
  pg_user="$(grep '^POSTGRES_USER=' "$REPO_DIR/.env.production" 2>/dev/null | cut -d= -f2-)"
  timeout 20 docker compose --env-file "$REPO_DIR/.env.production" -f "$REPO_DIR/docker-compose.prod.yml" \
    exec -T postgres psql -U "${pg_user:-royalhome}" -d royal_home_crm -tAc \
    "SELECT count(*) FROM \"LiveVoiceSession\" WHERE \"endedAt\" IS NULL AND \"startedAt\" > now() - interval '${LIVE_CALL_WINDOW_MIN} minutes'" \
    2>&1
}

# crm_live_call_gate <цель выката> <вывод запроса> <код запроса> — 0: выкатывать,
# 1: пропустить тик. Сама ничего не запрашивает — тестируется в изоляции
# (scripts/auto-deploy.test.mjs), строку для журнала печатает сама.
crm_live_call_gate() {
  local target="$1" raw="$2" rc="$3" count
  [ "${CRM_AUTODEPLOY_LIVE_CALL_GATE:-1}" = "1" ] || return 0
  [ "$target" = "web" ] && return 0
  count="$(printf '%s' "$raw" | tr -d '[:space:]')"
  if [ "$rc" != "0" ] || ! printf '%s' "$count" | grep -Eq '^[0-9]+$'; then
    say "проверка «идёт ли разговор робота» не удалась — выкатываем как обычно: ${raw:0:200}"
    return 0
  fi
  if [ "$count" -gt 0 ]; then
    say "идёт разговор робота (живых сессий: $count, моложе ${LIVE_CALL_WINDOW_MIN} мин) — тик пропущен, выкатим после звонка"
    return 1
  fi
  return 0
}

# ── ПОНЯТНОЕ СООБЩЕНИЕ О ПАДЕНИИ И ПОВТОР С ПАУЗОЙ (08.10.2026) ──────────────
# 08.10 выкат f030092c упал трижды за три минуты подряд одной и той же нехваткой
# памяти и встал навсегда — до следующего коммита. Повтор через минуту ничего не
# меняет: сервер в ту же минуту так же занят. А в Telegram уходило «смотри
# journalctl», что владельцу не говорит ничего. Теперь:
#   • причина называется словами, по выводу ops/deploy.sh;
#   • повтор — через 10 минут, 30 минут и 2 часа: за это время уходит ночная
#     копия, отпускает память, вычищается кэш сборки;
#   • в Telegram — первое падение (что, почему, что дальше), окончательный отказ
#     и возвращение к норме; промежуточные повторы только в журнал.

# crm_deploy_failure_reason <файл с выводом deploy.sh> — одна фраза для владельца.
crm_deploy_failure_reason() {
  local log="$1"
  if grep -Eqi 'heap out of memory|Cannot allocate memory|exit code: 137|Killed|out of memory' "$log" 2>/dev/null; then
    echo "серверу не хватило памяти при сборке новой версии"
  elif grep -Eqi 'no space left on device' "$log" 2>/dev/null; then
    echo "на сервере кончилось место на диске"
  elif grep -Fq 'миграции не применились' "$log" 2>/dev/null; then
    echo "не применилось изменение базы данных (миграция)"
  elif grep -Fq 'health не ответил' "$log" 2>/dev/null; then
    echo "новая версия не запустилась (не ответила на проверку)"
  elif grep -Fq 'контейнеры не поднялись' "$log" 2>/dev/null; then
    echo "новая версия не запустилась"
  elif grep -Fq 'сборка образа' "$log" 2>/dev/null; then
    echo "новая версия не собралась"
  elif grep -Eq 'дерево не продвигается|git pull не прошёл' "$log" 2>/dev/null; then
    echo "на сервере правили файлы руками, и код не обновить"
  else
    echo "причина не распознана автоматически"
  fi
}

# crm_retry_wait_seconds <номер прошедшей попытки> — пауза перед следующей.
# Пусто — попытки кончились.
crm_retry_wait_seconds() {
  case "$1" in
    1) echo 600 ;;
    2) echo 1800 ;;
    3) echo 7200 ;;
    *) echo "" ;;
  esac
}

# crm_deploy_failure_message <попытка> <из скольких> <причина> <заголовок коммита>
crm_deploy_failure_message() {
  local tries="$1" max="$2" reason="$3" title="$4" wait next
  wait="$(crm_retry_wait_seconds "$tries")"
  if [ "$tries" -lt "$max" ] && [ -n "$wait" ]; then
    next="Сам попробую ещё раз через $((wait / 60)) минут."
  else
    next="Попробовал $tries раза — больше сам не пробую, нужен разбор."
  fi
  printf 'Сайт НЕ обновился: %s. Работает прежняя версия, она в порядке. Правка: «%s». %s' \
    "$reason" "$title" "$next"
}

if [ "${CRM_AUTODEPLOY_SOURCE_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

mkdir -p "$STATE_DIR" 2>/dev/null || true
FAILED_SHA_FILE="$STATE_DIR/failed-sha"
FAILED_TRIES_FILE="$STATE_DIR/failed-tries"
FAILED_AT_FILE="$STATE_DIR/failed-at"
# ПОЧЕМУ СРАВНИВАЕМ С «ЧТО ВЫКАЧЕНО», А НЕ С РАБОЧИМ ДЕРЕВОМ.
# ops/deploy.sh СНАЧАЛА делает git pull, и только потом собирает образы и
# проверяет health. Значит после упавшего выката HEAD на сервере уже равен
# origin/main, хотя на проде крутятся старые контейнеры. Если решать «пора или
# не пора» по HEAD, такой выкат не повторится НИКОГДА: таймер будет молча тикать
# вхолостую над сломанным продом — ровно та тишина, из-за которой вставший
# 15.09 выкат заметили только на четвёртый день. Поэтому ведём свой файл с
# коммитом, который в последний раз доехал до зелёного health.
DEPLOYED_SHA_FILE="$STATE_DIR/deployed-sha"
QUIET_FILE="$STATE_DIR/quiet-since"

# ── 0. Один выкат за раз ─────────────────────────────────────────────────────
# Таймер тикает раз в минуту, а выкат со сборкой образов занимает 1,5-3 минуты.
# Без замка второй тик влезал бы в середину первого — ровно тот случай, из-за
# которого в deploy.yml стоит `cancel-in-progress: false` (11.08.2026: четыре
# наехавших друг на друга выката, контейнеры-сироты, 502 снаружи).
exec 9>"$LOCK_FILE" 2>/dev/null || true
if ! flock -n 9; then
  say "предыдущий выкат ещё идёт — пропускаем тик"
  exit 0
fi

cd "$REPO_DIR" || { say "нет каталога $REPO_DIR"; exit 1; }

# ── 1. Рабочее дерево прода должно быть чистым и на своей ветке ──────────────
# Если кто-то правил файлы прямо на сервере или переключил ветку, автоматический
# выкат молча затёр бы это или, наоборот, выкатил не то. Такое разбирается
# руками; наше дело — заметить и сказать вслух, а не чинить самому.
# Ошибку git печатаем, а не проглатываем. 19.09.2026 первый запуск на сервере
# написал «ветка '?'» и вышел молча — за этим пряталось то, что systemd не задал
# HOME и git не видел ни .gitconfig, ни .ssh/config (см. Environment=HOME= в
# ops/install-auto-deploy.sh). С проглоченной ошибкой это выглядело как «просто
# не та ветка», то есть как штатный случай, и искать было нечего.
if ! CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>&1)"; then
  say "git не смог прочитать ветку: $CURRENT_BRANCH"
  say "обычно это HOME или safe.directory у сервиса — перезапусти sudo ./ops/install-auto-deploy.sh"
  exit 1
fi
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  say "на сервере ветка '$CURRENT_BRANCH', а не '$BRANCH' — автовыкат не трогает"
  exit 0
fi
# ТОЛЬКО ОТСЛЕЖИВАЕМЫЕ ФАЙЛЫ (19.09.2026, поймано на живом сервере).
#
# Было `git status --porcelain`, а он считает и НЕОТСЛЕЖИВАЕМЫЕ файлы. На проде
# их всегда полно и это норма: рядом с .env.production лежат семь его резервных
# копий, которые за месяцы наделали разные скрипты
# (.env.production.bak-20260822, .bak-gemini-20260830-1333 и так далее), плюс
# deploy-logs/. Ни один из них к коду отношения не имеет и слиянию не мешает.
#
# С прежней проверкой автовыкат встал бы на этом НАВСЕГДА и каждую минуту писал
# «кто-то правит файлы прямо на сервере» — при том, что никто ничего не правил.
#
# Смысл проверки в другом: правка ОТСЛЕЖИВАЕМОГО файла прямо на сервере — это то,
# что уронит `git pull --ff-only` в deploy.sh и что автовыкат затёр бы молча.
# Её и ловим: --untracked-files=no.
DIRTY="$(git status --porcelain --untracked-files=no 2>/dev/null)"
if [ -n "$DIRTY" ]; then
  say "на сервере правили файлы репозитория, автовыкат стоит:"
  # Файлы называем поимённо: без них сообщение говорит о проблеме, но не даёт
  # ничего, с чем идти разбираться (тот же урок, что с проглоченной ошибкой git).
  echo "$DIRTY" | head -20 | while IFS= read -r line; do say "    $line"; done
  exit 0
fi

# ── 2. Сдвинулся ли origin/main ──────────────────────────────────────────────
# Текст ошибки пишем в журнал: моргнувшая сеть и «нет доступа к GitHub» выглядят
# в тике одинаково, а чинятся совсем по-разному. Шуметь в Telegram при этом не
# надо — следующий тик через минуту.
if ! FETCH_ERR="$(git fetch --quiet origin "$BRANCH" 2>&1)"; then
  say "git fetch не прошёл, ждём следующего тика: ${FETCH_ERR:-без текста ошибки}"
  exit 0
fi

HEAD_SHA="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
LOCAL="$(cat "$DEPLOYED_SHA_FILE" 2>/dev/null || true)"

# ПЕРВЫЙ ЗАПУСК ПОСЛЕ УСТАНОВКИ ВЫКАТЫВАЕТ ВСЕГДА (19.09.2026).
#
# Своего файла ещё нет, и что именно крутится в контейнерах, мы не знаем: код в
# рабочем дереве и код в запущенном образе — разные вещи. Считать выкаченным
# HEAD нельзя, и вот почему это не теория. Установка идёт командой
#   cd /opt/royalhome-crm && git pull --ff-only && sudo ./ops/install-auto-deploy.sh
# — то есть к моменту первого тика `git pull` УЖЕ подтянул main, HEAD равен
# origin/main, а контейнеры всё ещё старые. По HEAD первый тик не сделал бы
# ничего, установка отчиталась бы «готово», и прод остался бы на прежнем коде с
# новыми исходниками на диске — молча, до следующего чужого коммита.
#
# Поэтому: файла нет — выкатываем, не рассуждая. Пересборка уже выкаченного кода
# безвредна (образы соберутся из кэша, контейнеры перезапустятся), а гарантия
# «после установки на проде ровно origin/main» стоит этих полутора минут.
FIRST_RUN=0
if ! git cat-file -e "${LOCAL}^{commit}" 2>/dev/null; then
  FIRST_RUN=1
  LOCAL="$HEAD_SHA"
  say "первый запуск: что выкачено — неизвестно, выкатываем ${REMOTE:0:8} принудительно"
fi

if [ "$FIRST_RUN" = "0" ] && [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

# Откат ветки назад (force-push в main) автовыкат не делает: `git pull --ff-only`
# в deploy.sh такое не пропустит, и правильно — это всегда разбор руками.
if ! git merge-base --is-ancestor "$HEAD_SHA" "$REMOTE"; then
  say "origin/$BRANCH не является продолжением того, что на сервере — нужен человек"
  crm_telegram_alert "автовыкат остановлен: origin/$BRANCH разошёлся с кодом на сервере (force-push?). Нужен человек." "⛔️" || true
  exit 0
fi

# ── 2.4. Только проверенное командой выката ──────────────────────────────────
# Разбор — у функции crm_ship_verified выше. Алерт в Telegram — один раз на
# коммит, дальше только строка в журнале на каждом тике.
if [ "${CRM_AUTODEPLOY_SHIP_GATE:-1}" = "1" ] && ! crm_ship_verified "$REMOTE"; then
  say "вершина ${REMOTE:0:8} влита мимо npm run ship (нет строки Ship-Verified с её деревом) — на сайт не выкатываем, ждём проверенного коммита"
  UNVERIFIED_FILE="$STATE_DIR/unverified-alerted"
  if [ "$(cat "$UNVERIFIED_FILE" 2>/dev/null)" != "$REMOTE" ]; then
    echo "$REMOTE" > "$UNVERIFIED_FILE"
    crm_telegram_alert "в main влито мимо проверки (${REMOTE:0:8}) — на сайт не выкатываю. Следующий npm run ship проверит и выкатит." "⛔️" || true
  fi
  exit 0
fi

# ── 2.5. Тихий период — склейка подряд идущих выкатов ────────────────────────
# FIRST_RUN пропускает ожидание: что крутится в контейнерах — неизвестно
# (см. комментарий у FIRST_RUN выше), тянуть с этим лишние 10 минут хуже, чем
# лишняя пересборка уже выкаченного кода.
if [ "$FIRST_RUN" = "0" ]; then
  TIP_MSG="$(git log -1 --pretty=%B "$REMOTE" 2>/dev/null || true)"
  if printf '%s' "$TIP_MSG" | grep -qF '[deploy-now]'; then
    say "сообщение коммита содержит [deploy-now] — выкатываем без ожидания тишины"
    rm -f "$QUIET_FILE" 2>/dev/null || true
  elif ! crm_quiet_period_ok "$REMOTE" "$QUIET_FILE" "$QUIET_SECONDS" "$(date +%s)"; then
    say "ждём тишины на ${REMOTE:0:8} (порог ${QUIET_SECONDS}с) — тик пропущен, следующий выкатит, если вершина не сдвинется"
    exit 0
  else
    say "тишина на ${REMOTE:0:8} держится ≥${QUIET_SECONDS}с — выкатываем"
  fi
fi

# ── 3. Сломанный коммит не пересобирается вечно ──────────────────────────────
TRIES=0
if [ -f "$FAILED_SHA_FILE" ] && [ "$(cat "$FAILED_SHA_FILE")" = "$REMOTE" ]; then
  TRIES="$(cat "$FAILED_TRIES_FILE" 2>/dev/null || echo 0)"
  if [ "$TRIES" -ge "$MAX_TRIES" ]; then
    say "коммит ${REMOTE:0:8} уже падал $TRIES раза — ждём следующий коммит"
    exit 0
  fi
  # Пауза между попытками (см. crm_retry_wait_seconds): повтор в ту же минуту
  # падал той же нехваткой памяти.
  WAIT_S="$(crm_retry_wait_seconds "$TRIES")"
  FAILED_AT="$(cat "$FAILED_AT_FILE" 2>/dev/null || echo 0)"
  if [ -n "$WAIT_S" ] && [ "$(( $(date +%s) - ${FAILED_AT:-0} ))" -lt "$WAIT_S" ]; then
    exit 0
  fi
fi

# ── 4. Правки одной документации сервер не пересобирают ──────────────────────
# То же решение, что в ci.yml: коммит, меняющий только docs/ и *.md, на проде не
# меняет ничего, а полная пересборка образов стоит полторы минуты простоя api.
# Код всё равно подтягиваем — иначе следующая правка кода поедет вместе с этой
# и разница между «что на сервере» и «что в main» будет врать.
CHANGED="$(git diff --name-only "$LOCAL" "$REMOTE" || true)"
ONLY_DOCS=1
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    docs/*|*.md) ;;
    *) ONLY_DOCS=0; break ;;
  esac
done <<<"$CHANGED"

# На первом запуске пропуск запрещён: мы не знаем, что в контейнерах, и «там
# только документация» ничего не доказывает.
if [ "$FIRST_RUN" = "0" ] && [ "$ONLY_DOCS" = "1" ] && [ -n "$CHANGED" ]; then
  say "в ${REMOTE:0:8} только документация — подтягиваем без пересборки"
  # Подтягиваем ровно проверенную вершину, а не свежий main: пока шёл разбор, в
  # main мог лечь коммит без Ship-Verified (аудит Codex 04.10, OPS-01).
  git merge --ff-only --quiet "$REMOTE" || say "слияние с ${REMOTE:0:8} не прошло"
  echo "$REMOTE" > "$DEPLOYED_SHA_FILE"
  exit 0
fi

# ── 4.5. Что именно пересобирать ─────────────────────────────────────────────
# ЗАЧЕМ РАЗБИРАТЬ (19.09.2026). Раньше сюда всегда уходил выкат «all»: образы
# api и web пересобирались оба, и пересоздавались все три контейнера. Контейнер
# web — это раздача самого приложения, и пока он поднимается, снаружи лежит вся
# CRM, а не один раздел. Выкатов бывает по два десятка в день, каждый в
# случайную минуту — получается ровно то, на что жаловался владелец: «то
# дашборд не грузится, то чаты», при том что в журнале API ни одной ошибки.
#
# Правка одного бэкенда веб-контейнера не касается вовсе (в deploy.sh для цели
# `api` он больше не перезапускается), правка одного фронтенда — не касается
# api. Пересобирать обоих нужно только когда тронуто общее: packages/shared,
# корневые манифесты, сам compose.
#
# Если под правила не подошло ничего (например, тронуты только scripts/), берём
# «all»: лишняя пересборка дешевле, чем невыкаченная правка.
NEED_API=0
NEED_WEB=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    apps/api/*) NEED_API=1 ;;
    apps/web/*) NEED_WEB=1 ;;
    packages/shared/*|package.json|package-lock.json|docker-compose.prod.yml) NEED_API=1; NEED_WEB=1 ;;
    docs/*|*.md|ops/*|.github/*|scripts/*) ;;
    *) NEED_API=1; NEED_WEB=1 ;;
  esac
done <<<"$CHANGED"

if [ "$FIRST_RUN" = "1" ]; then
  TARGET="all"
elif [ "$NEED_API" = "1" ] && [ "$NEED_WEB" = "1" ]; then
  TARGET="all"
elif [ "$NEED_WEB" = "1" ]; then
  TARGET="web"
elif [ "$NEED_API" = "1" ]; then
  TARGET="api"
else
  TARGET="all"
fi

# ── 4.9. Не рвём разговор робота ─────────────────────────────────────────────
# Разбор — у crm_live_call_gate выше. Пропуск безопасен для остального: файлы
# состояния не трогаем, следующий тик через минуту решит заново.
LIVE_RC=0
LIVE_RAW=""
if [ "$TARGET" != "web" ] && [ "${CRM_AUTODEPLOY_LIVE_CALL_GATE:-1}" = "1" ]; then
  LIVE_RAW="$(crm_live_voice_calls_query)" || LIVE_RC=$?
fi
if ! crm_live_call_gate "$TARGET" "$LIVE_RAW" "$LIVE_RC"; then
  exit 0
fi

# ── 5. Выкат ─────────────────────────────────────────────────────────────────
if [ "$FIRST_RUN" = "0" ]; then
  say "origin/$BRANCH уехал вперёд: ${LOCAL:0:8} → ${REMOTE:0:8}, выкатываем ($TARGET)"
fi
# --sha=: deploy.sh сам ставит дерево на REMOTE (под своим замком) и не тянет main
# повторно, иначе собрался бы не тот коммит, который проверили и по diff которого
# выбрали цель (аудит Codex 04.10, OPS-01). Код 3 — «дерево уже ушло дальше, пока
# ждали замок» (выкатил другой путь): не падение, следующий тик решит заново.
#
# Место под сборку (08.10.2026): ночная копия видео объектов пишет ~9 ГБ рядом с
# двумя прежними, и в этот час на диске остаётся меньше гигабайта — сборка падает
# «no space left». Кэш сборки — только пересоздаваемые слои (его каждую ночь
# чистит /opt/docker-cache-cleanup.sh), поэтому при нехватке места чистим его
# заранее, а не падаем.
FREE_KB="$(df -Pk / | awk 'NR==2 {print $4}')"
if [ "${FREE_KB:-0}" -lt "${CRM_AUTODEPLOY_MIN_FREE_KB:-6291456}" ]; then
  say "на диске свободно $((FREE_KB / 1024 / 1024)) ГБ — чищу кэш сборки Docker перед выкатом"
  docker builder prune -af >/dev/null 2>&1 || true
fi
DEPLOY_LOG="$(mktemp /tmp/royalhome-deploy.XXXXXX)"
DEPLOY_RC=0
"$REPO_DIR/ops/deploy.sh" "$TARGET" --sha="$REMOTE" 2>&1 | tee "$DEPLOY_LOG"
DEPLOY_RC="${PIPESTATUS[0]}"
REASON="$(crm_deploy_failure_reason "$DEPLOY_LOG")"
rm -f "$DEPLOY_LOG" 2>/dev/null || true
TITLE="$(git log -1 --pretty=%s "$REMOTE" 2>/dev/null || echo "${REMOTE:0:8}")"
if [ "$DEPLOY_RC" = "3" ]; then
  say "выкат ${REMOTE:0:8} уступил: дерево уже дальше проверенной вершины, решим на следующем тике"
  exit 0
fi
if [ "$DEPLOY_RC" = "0" ]; then
  echo "$REMOTE" > "$DEPLOYED_SHA_FILE"
  rm -f "$FAILED_SHA_FILE" "$FAILED_TRIES_FILE" "$FAILED_AT_FILE" "$QUIET_FILE" 2>/dev/null || true
  say "выкат прошёл: $(git log --oneline -1)"
  # Про удачный выкат НЕ пишем в Telegram: их бывает по два десятка в день, и
  # такой поток читать перестают — а тогда не прочтут и сообщение о падении.
  # Если предыдущая попытка падала, о возвращении к норме сказать стоит.
  if [ "$TRIES" -gt 0 ]; then
    crm_telegram_alert "Сайт обновился, с попытки $((TRIES + 1)): «${TITLE}»." "✅" || true
  fi
else
  TRIES=$((TRIES + 1))
  echo "$REMOTE" > "$FAILED_SHA_FILE"
  echo "$TRIES" > "$FAILED_TRIES_FILE"
  date +%s > "$FAILED_AT_FILE"
  say "выкат УПАЛ на ${REMOTE:0:8} (попытка $TRIES из $MAX_TRIES): $REASON"
  if [ "$TRIES" = "1" ] || [ "$TRIES" -ge "$MAX_TRIES" ]; then
    crm_telegram_alert "$(crm_deploy_failure_message "$TRIES" "$MAX_TRIES" "$REASON" "$TITLE")" "⛔️" || true
  fi
  exit 1
fi
