# CLAUDE.md — Royal Home CRM

Guidance for Claude Code when working in this repository.

## Current public workflow — 21.10.2026

The active source is `DalerJaborov/royal-home-crm-public`, with independent clean
history. Follow the public-repository section in AGENTS.md: `npm run ship` runs
source checks and, when required, the complete API suite on GitHub-hosted Linux.
No local PostgreSQL/build is needed for that default path; `--local-tests` is
the explicit fallback. Do not merge old private history into this repository.
Production deployment has not been connected to this new repository; do not
report a production update solely from a successful GitHub merge. The older
self-hosted-runner and deployment descriptions below describe the prior setup.

## Project

`royal-home-crm` — a CRM built as an npm-workspaces monorepo. Full-stack TypeScript:
React/Vite web client, Express API, Prisma/PostgreSQL, shared Zod schemas.

## Structure

```
apps/api        @royal-home/api      Express + TypeScript (tsx), Prisma, JWT auth
apps/web        @royal-home/web      React 18 + Vite + Tailwind + PWA
packages/shared @royal-home/shared   Shared Zod schemas/types (imported by api & web)
```

## Порядок любой правки — для любого чата (с 02.10.2026)

Одинаково в проекте claude.ai, в чате Claude Code на компьютере и с другой учётки:

1. **Начало.** `git fetch origin main`, своя ветка от свежего `origin/main`;
   `npm run build:shared && npm run prisma:generate`.
2. **До правки — кого она заденет.** `npm run where -- --file <путь>` (кто
   зависит от файла) и `node scripts/impact-tests.mjs --for=<путь>`; каждого
   зависимого правка обязана не сломать. Нашёл баг — ищи тот же механизм в
   соседних путях и на телефоне, и на компьютере. Убирать только то, что просили.
3. **После правки.** Тест на починку; `npm run map`, затем `npm run map:check`
   (сторож пропаж `map:gate` красный — значит, правка унесла экран или путь);
   `npm run precheck` зелёный; запись `docs/journal/ГГГГ-ММ-ДД-о-чём.md`.
4. **Сохранить.** Коммит, `git push -u origin <своя ветка>`, черновик PR.
5. **На сайт — только `npm run ship` из основной папки** (не из worktree): он
   сводит с `main`, гоняет precheck и полный `test:api`, ставит строку
   `Ship-Verified` и вливает; сервер выкатывает сам. Владелец просит «влей»,
   «на сайт», «выкати» — чат запускает `npm run ship` сам. Одна команда ship за
   раз; «main ушёл вперёд» — запустить заново. Красный ship чинится и
   запускается снова, не обходится.
6. **Никогда:** кнопка вливания на GitHub, `merge_pull_request`, `gh pr merge`,
   `git push` в `main`. Это держат машины: запрет в `.claude/settings.json`,
   git-хук `.githooks/pre-push` (push в `main` только со строкой `Ship-Verified`
   своего дерева; подключается сам в начале сессии) и сервер выката.

## Ни ключей, ни номеров клиентов в репозитории (с 20.10.2026, железное правило)

Владелец: «чтобы туда ничего конфиденциального никогда не попало — ни от тебя, ни от Codex».
- **Никогда не коммитить:** ключи, токены, пароли, `.env`/`.env.*` (кроме `*.example`),
  ключи SSH и сертификаты, дампы базы, выгрузки клиентов. Секрет живёт в `.env` на сервере
  или в Настройках CRM (там он зашифрован), в коде и тестах — только заглушки
  (`change-me…`, `test-…`, `stand-…`).
- **Номер телефона клиента или сотрудника в `docs/`, `*.md`, разборах и журналах — только
  маской** `+992•••••3726`. Имя клиента рядом с номером тоже не нужно — пиши «клиент ПК-000463».
- Это держат машины: хук `.githooks/pre-commit` и шаг `audit:secrets` в `npm run precheck`
  (значит, и в `npm run ship`) — `scripts/audit-secrets.mjs`. Ложная тревога — пометка
  `secret-scan: allow` в той же строке с причиной; `--mask-docs` сам маскирует номера.
- Ключ всё-таки попал в коммит или пуш — он **утёк**: сказать владельцу, сменить его у
  сервиса; удаление из файла его не спасает (история git хранит всё).
- Скан всей истории 20.10.2026 (gitleaks, 5837 коммитов): боевых ключей нет, `.env` и
  ключей SSH не было ни разу; номера клиентов в текущих документах замаскированы
  (в старой истории они остаются, пока репозиторий приватный — это принято).

## На сайт — только `npm run ship` (с 24.09.2026, железное правило)

Влитое в `main` уезжает на сайт через минуту, проверки GitHub не запускаются —
поэтому **в `main` правка попадает только командой `npm run ship`**: она сводит
ветку с `main` по явному sha, гоняет `precheck` и полный `test:api` (0 падений),
ловит ссылки 120000/160000 и лишь тогда вливает squash со строкой-отметкой
`Ship-Verified: tree=<дерево>` в сообщении, если `main` не сдвинулся; на первом
красном шаге останавливается и называет его. **Сервер выката берёт на сайт
только вершину `main` с этой строкой и совпадающим деревом** (`ops/auto-deploy.sh`,
выбор Dan 24.09): влитое мимо команды на сайт не попадёт. **Вручную не вливать** —
ни кнопкой, ни `merge_pull_request` из чата, ни `git push` в `main`; строку руками
не писать.
**Правки одной темы копить по 2–3 в одну**: каждое вливание требует у остальных
свой прогон. Полный прогон сервера пропускается сам, если правка не трогает
сервер и общую часть (правило «пачки»). В проекте claude.ai очередь ведёт
координатор (`npm run ship -- --no-merge`, по сигналу — `npm run ship`); чат
Claude Code на компьютере владельца запускает `npm run ship` сам (02.10.2026). `--dry-run` — план без изменений,
`--clean-db` — прогон на новой пустой базе. Защита `main` на GitHub на этом
тарифе недоступна (403, проверено 25.09) — `main` держит только сервер.
Статус GitHub облачные сессии ставить не могут (прокси, 403) — поэтому отметку
сторожит сервер. Разбор — [docs/ship.md](docs/ship.md).

## CI на своём Windows-раннере

С 22.09.2026 обязательные проверки (`ci.yml`, `gitleaks.yml`, `nightly-e2e.yml`)
идут не у GitHub, а на своём self-hosted раннере — ноутбуке владельца
(`daler-laptop`), Windows. Раньше это была облачная Linux-машина
(`ubuntu-latest`): чистая на каждый прогон, `bash` в PATH — настоящий,
`services:` поднимает контейнеры, `.cmd`-обёртки (`npx.cmd`, `npm.cmd`) не
существуют вовсе. Ни одно из этих допущений на новом раннере не работает
молча — три уже нашли и закрыли (22.09.2026, разбор в комментариях
`ci.yml`/`audit-deps-gate.mjs`/`.gitattributes`):

1. `bash` без явного пути резолвился в заглушку WSL раньше настоящего Git
   Bash.
2. `spawnSync("npx", …)` падал `ENOENT`: Windows не умеет исполнять `.cmd`
   напрямую, `CreateProcess` нужен `shell: true`.
3. Скрипты, сверяющие сгенерированный файл байт-в-байт (`map:check`),
   красили честное совпадение как расхождение — checkout на Windows отдаёт
   `\r\n`, а генератор пишет `\n`.

Три правила, которые держат класс закрытым:

- **Любой вызов `.cmd`/`.bat`-обёртки** (`npx`, `npm`, `prisma`, `playwright`
  через `npx`, и вообще всё, что резолвится в `<имя>.cmd` в `node_modules/.bin`)
  из `spawn`/`spawnSync`/`execFile` — только с `shell: true` (или
  `process.platform === "win32"` веткой, если `shell: true` нежелателен по
  другой причине). `execSync`/`exec` со строкой команды уже идут через shell —
  их это не касается.
- **Только LF для любого файла, который скрипт сравнивает байт-в-байт или
  строка-в-строку.** Решать не только `.gitattributes` (`eol=lf` на
  checkout — уже есть общим правилом `* text=auto eol=lf`), но и сама функция
  сравнения: нормализовать `\r\n → \n` перед `!==`, как сделано в
  `scripts/product-map.mjs`, `scripts/product-flows.mjs`,
  `scripts/product-map-simple.mjs`. Два слоя защиты, потому что `.gitattributes`
  можно забыть добавить для нового файла, а нормализация в коде — нет.
- **Никаких Linux-только команд в шагах workflow**, которые идут на этом
  раннере: `apt-get`, `--with-deps` у `playwright install` (ставит системные
  библиотеки через apt), `services:` (на Windows-раннере GitHub этот блок
  молча игнорирует — контейнеры для него поднимает только Docker-сеть Linux),
  бинарник вместо Docker-образа для инструмента, у которого нет
  Windows-сборки (пример: `gitleaks` теперь запускается образом
  `zricethezav/gitleaks`, не `_linux_x64.tar.gz`).

**Перезапуск раннера.** В репозитории нет скрипта или документа с рецептом
перезапуска службы раннера на `daler-laptop` — только `ci.yml` называет его
происхождение вскользь, в комментариях о переезде. Если раннер завис или не
подхватывает задания, служба GitHub Actions Runner на Windows обычно
называется `actions.runner.<org>.<hostname>` и управляется как обычная
Windows-служба (`Get-Service actions.runner.*`, `Restart-Service`) — но эта
команда НЕ проверена в этом репозитории и не является установленной здесь
процедурой; спросить владельца или искать фактическую установку на самом
`daler-laptop`, прежде чем действовать по ней.

## Журнал: каждая правка оставляет запись (с 23.09.2026, обязательно)

Владелец (21.09): всё сделанное должно сохраняться так, чтобы работу можно было
продолжить с ЛЮБОЙ другой учётной записи Claude. Память проекта claude.ai с другой
учётки не видна — переживает только репозиторий. Поэтому:

- **Начало сессии — [docs/JOURNAL.md](docs/JOURNAL.md)**: что за проект, решения
  владельца, что от него ждут, очередь. Копия памяти Claude на 23.09 —
  `docs/claude-memory/`.
- **Каждая правка, меняющая код или принимающая решение, добавляет файл
  `docs/journal/ГГГГ-ММ-ДД-о-чём.md`** — что изменилось, почему, чем проверено, что
  осталось (образец — `docs/journal/README.md`). Файл на правку, а не строка в
  общий конец: параллельные ветки иначе конфликтуют.
- Новое решение владельца или общее правило — ещё и строкой в `docs/JOURNAL.md`,
  раздел «Решения».
- Сторож `scripts/journal-gate.mjs` (шаг CI «Журнал — запись о правке» и
  `npm run precheck`) не пропускает правку с изменённым кодом без записи.
  Запись правда не нужна — метка «журнал-не-нужен» (локально `JOURNAL_GATE_SKIP=1`).

## Commands (run from repo root)

```bash
docker compose up -d       # start PostgreSQL 16 (service: postgres, port 5432)
npm run build:shared       # build @royal-home/shared to dist/ — REQUIRED once before first dev:api/dev:web
npm run dev:api            # Express dev server (tsx watch src/index.ts)
npm run dev:web            # Vite dev server
npm run build               # build shared -> api -> web, in order
npm run build:api           # build shared -> api only
npm run build:web           # build shared -> web only
npm run test:api            # vitest access-control tests (apps/api/tests), needs DB up
npm run test:web            # vitest tests of apps/web; no DB needed (size: see the measurement below)
npm run prisma:generate    # regenerate Prisma client
npm run prisma:migrate     # create/apply a dev migration
npm run prisma:seed        # seed the database
npm run map                # regenerate docs/product-*.{md,json} from current code
npm run map:check          # verify docs/product-* match code (exit 1 if stale) — part of precheck/CI
npm run ship               # the ONLY way to main/prod: sync, precheck, full test:api, mark «проверено», squash-merge
npm run ship -- --dry-run  # plan + blockers, changes nothing (--no-merge: stop before merging)
```

`@royal-home/shared`'s `main`/`types` point at `dist/`, not `src/` — after editing anything in
`packages/shared/src`, re-run `npm run build:shared` (or `npm run dev --workspace=packages/shared`
for a `tsc --watch`) or apps/api and apps/web will keep resolving the stale compiled output.

Per-workspace: `npm run build --workspace=apps/api`, etc. Node 24, npm workspaces (no pnpm/yarn).

## Карта продукта (docs/product-map*, docs/product-flows*) — не редактируется руками

Ни одна строка в `docs/product-map.md`, `docs/product-flows.md`,
`docs/product-map-simple.json` не набрана человеком — все три собираются
скриптами (`scripts/product-map.mjs`, `scripts/product-flows.mjs`,
`scripts/product-map-simple.mjs`) из исходников: маршруты `App.tsx` +
`navigation.ts`, модули `app.ts`, задачи `scheduleTracked` в `cron.ts`,
обработчики `jobs/*`, вызовы `api("/...")` во фронте. Правится не карта, а
код — карта сама подхватит при пересборке.

- **`npm run where <слова>` — СПРОСИТЬ карту вместо перебора `grep` по угаданным
  словам.** Отвечает сразу по всем слоям: экран, путь сервера, задача по
  расписанию, фоновое задание, файлы. Ещё два вопроса, на которые перебором
  отвечают полчаса:
  - `npm run where -- --model Client` — кто трогает модель базы (пути из карты
    плюс файлы `lib/*`, куда карта не заглядывает);
  - `npm run where -- --file <путь>` — что файл импортирует и **кто зависит от
    него**, то есть кого задевает правка здесь.
  Этот же вывод печатается в начале каждой сессии (`.claude/hooks/session-orientation.mjs`).
- `npm run map` — перегенерировать все три файла разом из текущего кода.
- `npm run map:check` — часть `precheck` и CI: заваливает проверку, если код
  и `docs/product-*` разошлись (кто-то поменял код и забыл пересобрать).
- `npm run map:gate` — **сторож пропаж**, тоже часть `precheck` и CI. `map:check`
  отвечает только на вопрос «карта собрана из текущего кода» и остаётся зелёным,
  когда правка молча унесла экран или сорок путей: карту-то пересобрали. Сторож
  сравнивает карту ветки с картой `main` и не пропускает ПРОПАЖУ (прибавление не
  трогает никогда). Убрали намеренно — сказать это вслух:
  `MAP_GATE_ALLOW_REMOVALS=1` локально, метка `карта-убрано-намеренно` на правке
  в CI. Разбор — в шапке `scripts/map-gate.mjs`.
- Единственное, что МОЖНО править руками, — два словаря подписей/переводов,
  `docs/product-map-labels.json` и `docs/product-map-words.json`: они меняют
  только слова на карте, не добавляют и не убирают экраны или пути.
- `docs/product-map.md` (35 КБ) — единственный из трёх файлов, который реально
  читается глазами (экраны, модули, крон). `docs/product-flows.md` (~1 МБ,
  все развилки по каждому пути) и `docs/product-map-simple.json` (человеческие
  слова, но пока без страницы-просмотрщика) — инженерный/машинный уровень.
- При слиянии веток эти файлы как сгенерированный текст иногда конфликтуют —
  `git checkout --theirs` на них и `npm run map` заново (именно в таком
  порядке: сперва `--theirs`/переключение на актуальную версию, потом
  `npm run map`, и только потом `git add` — иначе в коммит уйдёт старая
  карта поверх новой).
- **Весь этот танец делает `npm run sync:main`** (22.09.2026) — свести свою
  ветку со свежим `main` одной командой, с правильным порядком шагов и
  безусловной пересборкой карты. Конфликт в любом файле, кроме
  `docs/product-*`, он не трогает: останавливается и называет файлы. Не пушит
  — пуш перезапускает десятиминутную проверку на единственном раннере, это
  решение того, кто сводит.
- **Развёл конфликт руками — доделай свод: `node scripts/sync-main.mjs --continue`**
  (25.09.2026). Свод, остановившийся на конфликте, до пересборки карты не
  доходит, и дальше ветку собирают руками — на #932 карта после ручного
  разрешения разошлась на восемь развилок и уехала бы красной в `main`.
  `--continue` доделывает ровно хвост: пересобрать карту и сверить. Простой
  повторный запуск это тоже делает, но он СНОВА идёт в `git fetch` и втягивает
  `main`, который мог уехать, пока разводили конфликт.
- **Расхождение бывает и БЕЗ конфликта git — после мержа в main мало собрать
  проект, обязательно ещё прогнать `map:check`** (22.09.2026, тот же класс,
  что поломка main 21.09 по типам, #643/#651). Две ветки, каждая сама по
  себе зелёная: у каждой код и её собственная карта сходятся. Слияние обеих
  в main не даёт конфликта в `docs/product-*` (правки пришлись на разные
  места файла или вторая ветка вообще не трогала карту), но код после
  слияния несёт изменения ОБЕИХ веток, а закоммиченный файл карты — только
  той, что смержилась последней. Числа (`forks`/`conditions` и т.п.) тихо
  расходятся с кодом, и это ловит только `map:check`, не сборка и не тесты.

## Как код попадает на прод — НЕ через GitHub (с 19.09.2026)

**Выкат делает сам сервер, а не GitHub Actions.** Это первое, что нужно знать про
этот репозиторий, и чаще всего именно здесь ошибаются.

На VPS работает systemd-таймер `royalhome-auto-deploy`: раз в минуту он смотрит
`origin/main` и, если ветка сдвинулась, зовёт `ops/deploy.sh`. Ничего больше
делать не нужно — **влитый в `main` код уезжает на прод сам в течение минуты**.

```bash
ssh rh-vps                                       # вход на сервер (85.198.70.182)
systemctl status royalhome-auto-deploy.timer     # включён ли
journalctl -u royalhome-auto-deploy -n 100       # что делал и почему не поехал
sudo systemctl stop royalhome-auto-deploy.timer  # выключить на время
cd /opt/royalhome-crm && sudo ./ops/install-auto-deploy.sh   # поставить заново
```

**Чего НЕ делать и не обещать владельцу:**

- не говорить «сейчас запущу выкат в Actions» и не слать туда `workflow_dispatch`:
  с 15.09.2026 GitHub глушит в этом репозитории ЛЮБОЙ запуск на уровне аккаунта —
  на каждый push заводится пустой прогон `BuildFailed` и гаснет за секунду, без
  единого задания. Падает и `ubuntu-latest`, и свой бесплатный раннер, и ручной
  запуск. Снимается только владельцем: github.com → Settings → Billing;
- не считать, что «зелёный PR = выкачено»: выкат теперь привязан к `main`, а не к
  прогону проверки;
- не трогать `.env.production` и его резервные копии `.env.production.bak-*` — их
  на сервере семь штук, они неотслеживаемые и это норма;
- **не править файлы репозитория прямо на сервере.** Автовыкат намеренно встаёт,
  если в `/opt/royalhome-crm` изменён отслеживаемый файл (он уронил бы
  `git pull --ff-only`), и пишет в журнал, какой именно.

**Проверить прод глазами из веб-сессии нельзя:** `crm.royalhome.tj` закрыт
политикой окружения, curl отдаёт `код 000` / `CONNECT tunnel failed, 403`. Это НЕ
признак того, что сайт лежит. Судить о выкате по журналу сервера: `ops/deploy.sh`
падает, если `/api/v1/health` не отдал 200, и предупреждает, если закрытый роут
`/api/v1/clients` ответил не 401 — значит строка «готово» означает, что обе
проверки прошли изнутри сервера.

**`deploy.yml` больше не запускается сам** (19.09.2026): у него остался только
ручной `workflow_dispatch` — отдушина на случай, если таймер на сервере выключен
или сломан. Автоматический запуск убран, чтобы после починки Billing каждый мерж
не выкатывался дважды и не жёг платные минуты. Оба пути берут общий замок
`/var/lock/royalhome-deploy.lock` и отмечают выкаченный коммит в
`/var/lib/royalhome-auto-deploy/deployed-sha` — **не убирать ни то, ни другое**:
без них два выката наедут друг на друга (конфликт имён контейнеров, 502 снаружи)
либо продублируются.

Разбор поломки и устройство автовыката —
[docs/deploy-without-actions-19-09.md](docs/deploy-without-actions-19-09.md).

## Stack

- **Frontend**: React, Vite, TypeScript, Tailwind CSS, React Router, TanStack Query
  (server state), Zustand (client state), dnd-kit (drag-drop), lucide-react (icons), PWA.
- **Backend**: Express, TypeScript, Prisma ORM, PostgreSQL, JWT (`jsonwebtoken`) + `bcrypt`,
  `zod` validation, `multer` uploads, `sharp` image processing, `cors`, `dotenv`.
- **Shared**: `@royal-home/shared` holds Zod schemas — define validation/types there once and
  import in both api and web. Do not duplicate types across apps.

## Working standards

Apply these by default whenever writing code or UI — don't wait to be asked:

- **Clean modular code.** Small, single-purpose modules. Reuse `@royal-home/shared` types.
  Match the style of surrounding code.
- **Validation at boundaries.** Every API input (body/params/query) and webhook payload is
  validated with a Zod schema before use. Trust internal code; validate external input.
- **Error handling up front.** API routes return proper status codes + structured errors.
  External calls (DB, AI, third-party) are wrapped and fail gracefully — never swallow errors.
- **Responsive, mobile-first UI.** Tailwind, mobile-first breakpoints, clear visual hierarchy,
  accessible forms and dashboards. Consistent spacing/typography.
- **Desktop and mobile ship together, same task.** Historically many screens rendered through a
  separate `components/mobile/Mobile*.tsx` component, and a feature added only to the desktop page
  was **invisible on mobile even though the code "works"** — nothing fails, nothing warns. It
  happened twice on `Oversight.tsx`/`MobileOversight.tsx`: three antifraud red flags (22.08) and a
  fourth (30.08) shipped to desktop only, unnoticed until the owner asked why he wasn't seeing them.

  **Since the 09.09.2026 port to the «Royal Home 2026» prototype the rule is stronger: a mobile
  file that carries no logic of its own is deleted, and one responsive screen stays.** The
  prototype's own media queries (820 and 640 px) do the narrow layout, so the two copies have
  nothing left to diverge over. Already done this way for `Profile`, `Finance`, `Reports`,
  `Sources`, `Archive`, `Oversight`, `Activity`, `Notifications`.

  **Before calling a screen-facing feature done:** grep for a `Mobile*.tsx` counterpart. If one
  still exists AND carries its own logic (gestures, its own lists), add the same data there too,
  in the prototype's idiom — `.pg-h`, `.sec-t`, `.card`, `.list` + `.row`, `.chip`, `.quiet` (see
  `apps/web/src/theme-2026-proto.css` and `docs/handoff-2026-09-09-theme-port.md`). If it exists
  and merely duplicates markup, delete it instead of maintaining two copies. If the page has no
  separate mobile component, keep both breakpoints in the same edit.
- **Security.** No secrets in code (use `.env`). Hash passwords (`bcrypt`), scope JWTs,
  sanitize file uploads and paths.

## Token & cost economy (strict)

- **Minimal output.** Return only new/changed code. No re-dumping unchanged files, no
  restating what wasn't asked. Keep explanations short unless the user requests detail.
- **Prompt caching.** For large, stable instructions or repeated file context, place
  `cache_control: { type: "ephemeral" }` on the stable prefix (system prompt / tool defs).
  Caching is a **prefix match with a token minimum** (~2048–4096 depending on model) — it only
  saves money above that threshold; below it the marker is a no-op. Verify with
  `usage.cache_read_input_tokens`.
- **GitHub Actions minutes — проверять раз в месяц** (введено 15.09.2026). Приватный
  репозиторий даёт 2000 бесплатных минут CI в месяц; при текущем темпе (CI ~10,5
  мин на прогон, много пушей в день + ночной сторож по всем веткам) лимит реально
  выбрать, дальше минуты платные. Смотреть на github.com → Settings → Billing →
  Actions usage.
- **Минуты Actions на выкат больше не тратятся** (19.09.2026): выкат ушёл на
  таймер на самом сервере — см. «Как код попадает на прод» в начале файла. Туда
  же, а не сюда, дописывать всё про выкат: правило про минуты и правило про
  выкат разъехались бы в разные стороны, если держать их в двух местах.

## AI model routing

When code calls Claude models, pick the cheapest tier that fits the request. (The standalone
example `router.js` that used to live in the repo root was removed on 28.09.2026 — it never ran:
its SDK was not a project dependency.)

| Tier | Use for | Model | Correct ID |
|---|---|---|---|
| SIMPLE | routine edits, tests, logging, formatting, classification | Haiku 4.5 | `claude-haiku-4-5` |
| MEDIUM | business logic, code, SQL, integrations | Sonnet 5 | `claude-sonnet-5` |
| COMPLEX | deep architecture, hard debugging, system design | Fable 5 | `claude-fable-5` |
| (heavy project work) | complex multi-step project tasks | Opus 4.8 | `claude-opus-4-8` |

Default to the cheapest tier that fits; escalate to expensive models only for complex
architecture or bugs unresolved on the first attempt.

### ⚠️ Model IDs — use only the current strings above

These older IDs are **retired and return HTTP 404** — never use them:

| Retired (do NOT use) | Replacement |
|---|---|
| `claude-3-5-haiku` | `claude-haiku-4-5` |
| `claude-3-5-sonnet` | `claude-sonnet-5` |
| `claude-3-opus` | `claude-opus-4-8` |
| `claude-3-7-sonnet`, `claude-4` | `claude-fable-5` |

### Model-specific API notes

- **Fable 5**: thinking is always on — do **not** send a `thinking` param (`{type:"disabled"}`
  → 400). No `temperature`/`top_p`/`budget_tokens`. Can return `stop_reason:"refusal"` — ship a
  server-side fallback (`betas:["server-side-fallback-2026-06-01"]`, `fallbacks:[{model:"claude-opus-4-8"}]`).
  Requires ≥30-day org data retention.
- **Sonnet 5 / Opus 4.8**: use `thinking:{type:"adaptive"}` + `output_config:{effort:"..."}`;
  `temperature`/`top_p` are rejected (400).
- **Haiku 4.5**: no `thinking`/`effort` params; keep requests simple and fast.
- Non-streaming: cap `max_tokens` ~16000 to avoid HTTP timeouts; stream for larger outputs.

## Проверка перед тем, как сказать «готово» (обязательно)

Правило появилось после 26 июля: карточка объекта упала в проде, а отчёт был
«94 теста зелёные». Тесты покрывают API, отрисовку не покрывал никто.

**После любых изменений — прогнать и приложить ПОЛНЫЙ вывод команд, а не пересказ.
Успехом считается только нулевой код возврата.**

Ритуал ослаблен 12.08.2026 по решению владельца: полный прогон делает не каждый
агент, а один раз тот, кто собирает работу перед выкатом. Смысл прежний — до
прода ни одна правка не доходит непроверенной, но одно и то же не гоняется шесть раз.

**Перед пушем — одна команда вместо списка (11.09.2026):** `npm run precheck` прогоняет
то же и в том же порядке, что CI (сборка shared/api/web с eslint, `audit:deps`,
`audit:theme`, `audit:nginx`, `map:check`, сторож пропаж на карте и тесты,
задетые правкой), печатает время каждого шага и предупреждает о незакоммиченных
правках; ~1,5 мин, код возврата честный.
**Что изменилось 22.09.2026:** шаг тестов брал ИЗМЕНЁННЫЕ файлы из
`apps/api/tests` — то есть при правке только в `src/` честно печатал «нечего
гонять» и не прогонял ничего. Теперь список считает граф импортов
(`scripts/impact-tests.mjs`): гоняются тесты, дотягивающиеся до изменённого кода. Раннер один и прогон CI занимает 10,5 минуты
— каждая правка, которую CI заворачивает на первом шаге, стоит этот час всей очереди.
Замер и разбор конвейера: `docs/ci-speed-10-09.md`.

**Обязательно ВСЕГДА (дёшево, ловит настоящие поломки):**

```bash
npm run build:shared && npm run build:api && npm run build:web   # типы + сборка (в build:web встроен eslint)
npm run test:api                                                  # код возврата честный
npm run test:web                                                  # база не нужна
#   Размер на 02.10.2026, 13:30 UTC: сервер 7776 тестов (число из отметки
#   Ship-Verified на вершине main — её пишет сам прогон); фронт 80 файлов,
#   476 тестов, девять секунд.
#   Сервер ~2,7 мин в один процесс на свободной машине, ~13 мин на занятой или в два
#   процесса на одной базе.
#   Числа здесь — ЗАМЕР С ДАТОЙ, а не постоянная величина, и в подписи шагов
#   `precheck` их намеренно нет: вписанное руками число ничем не сверяется и тихо
#   устаревает. Так уже было дважды: «183 файла, 1618 тестов» отстали в три с
#   половиной раза к 22.09, а «169 тестов» фронта — почти втрое к 02.10. И тут же
#   в третий раз, на самой этой строке: утром она говорила 7739 по отметке на
#   вершине main, а через два часа отметка #1044 сказала 7776. Поэтому у замера
#   стоит ЧАС, а не только дата, и смотреть надо не сюда, а на вершину main:
#   `git log -1 --format=%B origin/main | grep Ship-Verified`.
```

**Только когда трогали фронтенд:**

```bash
npm run lint --workspace=apps/web        # правило хуков — ошибка сборки, не замечание
npm run e2e --workspace=apps/web         # каждый экран открывается, консоль чистая
```

**Исполнителю одной задачи (агенту) достаточно** сборки и точечного прогона своих
и смежных тестов (`cd apps/api && npx vitest run <файлы>` — именно так: с `--root`
из корня `dotenv` в `tests/setup.ts` не найдёт `.env` и прогон упадёт на
`DATABASE_URL`). Полный прогон и e2e —
один раз на объединённой ветке перед мержем.

**Тронул `apps/web` — прогони `npm run test:web`, сборки НЕ хватает** (24.09.2026).
`npm run build:web` — это eslint + tsc + vite build, тестов фронта в нём нет вовсе,
и `cd apps/api && npx vitest run <файлы>` из строки выше их тоже не видит: там
только `apps/api`. Сторожа фронта (`noSmallText` и соседи) живут именно в них.
Живой случай: в `TranscriptView.tsx` подпись говорящего приехала с
инлайновым `fontSize: 12` — мельче тринадцати, — сборка и типы были чисты, поймал
только `test:web` при сведении. Прогон стоит около десяти секунд и базы не
требует, так что исключений у правила нет.

**Скорость важнее ритуала (владелец 10.09.2026).** Проверка делается ОДИН РАЗ НА
ПАЧКУ экранов/правок, а не на каждую: агент-исполнитель — только сборка,
сборщик — smoke e2e (`--grep @smoke`, не полный набор), сверка макетом и кадры
только там, где менялся вид. Полный `test:api` — только перед мержем в main.

### Что проверять глазами, чего инструменты не поймают

1. **Открыть на проде экран из затронутого раздела — если трогали фронтенд.**
   Сборка и тесты не видят упавший компонент. Для чисто серверных правок глазами
   смотреть нечего: хватает логов API и проверки здоровья.
   **Из веб-сессии (claude.ai/code) это невозможно:** `crm.royalhome.tj` закрыт
   политикой окружения, curl отдаёт `код 000` / `CONNECT tunnel failed, 403`.
   Это НЕ признак того, что сайт лежит, и обходить запрет нельзя. Оттуда судить
   о выкате по `journalctl -u royalhome-auto-deploy` на сервере, а глазами
   просит посмотреть владельца.
2. **Границы транзакций.** Несколько связанных записей меняются в одной `$transaction`
   или каждая сама по себе — второе тихо теряет атомарность.
3. **N+1.** `await` внутри `map`/`for` по списку из БД.
4. **Таймауты.** Каждый внешний вызов (ИИ, сайт, Telegram, курс) — с явным таймаутом
   и обработкой отказа; отказ обязан попасть в журнал через `logSystemError`.
5. **Пагинация.** Любой роут, возвращающий массив, должен иметь предел выборки.
6. **Идемпотентность.** Что будет, если вебхук доставится дважды.

### Чтобы правка здесь не ломала там (введено 22.09.2026)

Вопрос владельца дословно: «чтобы когда код меняется в одном месте, второе не
ломалось». Ловится это не усердием, а шестью слоями, от самого дешёвого. Первые
пять работают сами — четыре стоят в `npm run precheck` и в CI, пятый в хуке
после каждой правки; шестой — то, что делает человек.

1. **Типы через `packages/shared` — главный ловец.** Общие Zod-схемы и есть
   договор между сервером и клиентом: поменял поле — вторая сторона не
   собирается. Поэтому **никогда не гасить ошибку сборки расширением типа**
   (`as`, `any`, `?` на общем поле). Каждое такое расширение превращает поломку,
   пойманную за двадцать секунд, в поломку, найденную клиентом. Правка в
   `packages/shared` обязана пройти И `build:api`, И `build:web`.
2. **Правила импортов** (`npm run audit:deps:gate`): новый цикл импортов —
   это буквально «правлю здесь, ломается там», и он не проходит. Сюда же
   утечка серверного кода в клиентский бандл.
3. **Тесты, задетые правкой — по импортам, а не по именам файлов.** Шаг тестов
   в `precheck` считает список графом импортов (`scripts/impact-tests.mjs`):
   правишь `src/lib/…`, ни одного файла в `tests/` не трогаешь — тесты всё равно
   прогонятся, те самые, которые до этого кода дотягиваются. Граф НЕ видит
   динамический `import()` с вычисляемым путём и реестры обработчиков по
   строковому ключу — поэтому полный прогон он не отменяет.
   Тесты ФРОНТА (на 02.10.2026 — 80 файлов, 476 тестов, девять секунд) с
   22.09.2026 идут отдельным шагом и в `precheck`, и в обеих проверках CI. До этого они не гонялись
   нигде: `npm run build:web` их не видит (это eslint + tsc + vite build), а
   шаг тестов брал только `apps/api`.
4. **Сторож карты** (`npm run map:gate`): правка не может молча убрать экран
   или путь сервера. См. раздел о карте выше.
5. **Хук после правки говорит сам** (`.claude/hooks/post-edit-impact.mjs`,
   PostToolUse на Edit/Write). Ничего включать не надо: он лежит в репозитории,
   и его подхватывает ЛЮБАЯ сессия Claude Code, открытая в этой папке. Молчит,
   пока правка местная, и печатает в контекст сессии, когда от файла зависят
   пять и больше файлов, когда задето сорок и больше тестов, и — главное —
   когда **до файла не достаёт ни один тест, а зависимые есть**: поломка там
   пройдёт проверки зелёной.
6. **Найти второе место руками — до правки, а не после поломки.** Перед тем
   как трогать нетривиальный файл: `npm run where -- --file <путь>` и прочитать
   раздел «кто зависит от него». Спросить про ещё не сделанную правку можно и
   так: `node scripts/impact-tests.mjs --for=<путь>` — сколько тестов её
   заденет. Это пятисекундная версия правила «нашёл баг — ищи весь его класс»
   (ниже), только применённая заранее.

**Чего не видит ни один из шести слоёв — три слепых пятна (найдены 28–29.09.2026
при сведении #960 с #825, #997 и при разборе списка секретов).**

1. **Переезд экспорта мимо конфликта.** Ветка A выносит функцию в новый общий
   модуль и убирает вывоз из старого файла; ветка B в это же время добавляет
   файл, который зовёт её из СТАРОГО места. Файлы разные — `git merge` конфликта
   не показывает вовсе, обе ветки порознь зелёные, падает только сборка
   СВЕДЁННОЙ ветки: `TS2459: declares 'X' locally, but it is not exported` или
   `TS2305: has no exported member`. Живой случай: `signState`/`verifyState`
   уехали из `routes/tiktok.ts` в `lib/oauthState.ts`, а
   `routes/tiktokBusiness.ts` продолжал звать их оттуда же, где они лежали
   раньше. Увидел такую ошибку после свода — смотри не свой файл, а
   `git log -S "<имя>" -- <старый файл>` в свежем `main`: имя переехало, и
   лечится это переводом импорта на общее место, а не обратным вывозом.
2. **Конфликт, попавший в файл ТЕСТА, `precheck` не проверяет.** Шаг тестов
   считает список графом импортов от изменённого ИСХОДНИКА
   (`scripts/impact-tests.mjs`). Если правка свода легла только в
   `apps/api/tests/*`, задетых исходников нет, и зелёный `precheck` не говорит
   про этот тест ничего. Развёл конфликт в тесте — прогони этот файл руками:
   `cd apps/api && npx vitest run <файл>`.
3. **Файл-склад: строка, в которую дописывают все и не читает никто.** Сторож
   краснеет у ВСЕХ открытых веток разом, поэтому автор каждой дописывает
   недостающее от себя, не видя соседних. Так `openaiApiKey` оказался ЧЕТЫРЕ
   раза в `SECRET_SETTINGS_FIELDS` (`lib/settingsSnapshots.ts`), а `test:scripts`
   в корневом `package.json` расходится при каждом втором сведении. Такие места
   сводятся ТОЛЬКО объединением обеих сторон, выбор одной из них молча теряет
   чужую работу.

**Новый сторож проверяется внесением той поломки, которую он обязан ловить**
(29.09.2026). Проверка «нет повторов» была написана как
`fields.filter((f) => !seen.add(f))` и не краснела НИКОГДА: `Set.prototype.add`
возвращает сам `Set`, всегда истинный. Прогон был зелёный и с нарочно внесённым
повтором — сторож существовал, но не сторожил. Зелёный прогон одинаково
выглядит и когда всё хорошо, и когда сломана сама проверка, поэтому чтением
кода это не ловится: ломай нарочно и смотри на красное.

**Полный прогон — не ритуал, а последняя дверь перед сайтом.** Влитое в `main`
уезжает на сайт таймером в течение минуты (раздел «Как код попадает на прод»),
и никакая проверка между мержем и выкатом не стоит. Значит «полный прогон один
раз перед вливанием в `main`» — это не «раз в день для порядка», а обязательное
условие: другого шанса нет.

**Отдельная дыра, которую не закрывает ни один из шести слоёв: ветки проверяются
поодиночке, а вместе — никем.** Проверка правки гоняется на слиянии ЕЁ ветки с
`main` в тот момент; следующая правка в тот же час этого слияния уже не видела.
Две зелёные порознь правки дают красный `main` — и он сразу на сайте. Поэтому
после каждого вливания в `main` (тому, кто вливает, а не автору правки):

```bash
npm run build:api && npm run build:web
npm run map && npm run gen:typeset          # пересобрать ОБА генератора
npm run map:check && npm run audit:typeset  # и только потом проверить
```

Красный сторож генерируемого файла на `main` (`map:check` или
`audit:typeset`) блокирует ВСЕ остальные ветки сразу — чинить его отдельной
правкой вперёд очереди.

**`npm run map` стоит здесь ПЕРЕД проверкой, а не вместо неё** (24.09.2026,
пятый случай того же класса за сутки). Проверка честно краснит разошедшуюся
карту, но сама её не чинит, а краснеет она сразу у ВСЕХ открытых веток — цена
одной забытой пересборки не «полминуты у того, кто влил», а вся очередь.
Пересборка при совпадении не стоит ничего: вывод пустой, `git status` чист,
коммитить нечего. Разошлась — чинится тем же заходом, а не через полчаса
чужой красной проверкой.

Показательный случай — #933: расхождение было ровно в ОДНУ строку, аргумент
`{ resend: "all" }` у `dispatchInBackground`. Ни сборка, ни типы, ни тесты
такого не видят вообще. Красная карта на `main` появлялась 23–24.09 после
#860, #887, #891 и #933 — ни одно из этих вливаний не шло через свод, а свод
(`npm run sync:main`) пересобирает карту безусловно, и после него красной
карты за эти сутки не было ни разу.

**Генераторов отслеживаемых файлов в репозитории ДВА, и правило про оба**
(дописано в тот же вечер, через час после первого случая). Карта — не
единственный собираемый файл, лежащий в git:

| Генератор | Что собирает | Сторож |
|---|---|---|
| `npm run map` | `docs/product-map.md`, `docs/product-flows.md`, `docs/product-map-simple.json` | `npm run map:check` |
| `npm run gen:typeset` | `apps/web/src/theme-2026-typeset.css` | `npm run audit:typeset` |

Третьего нет: из `scripts/*.mjs` режим `--check` есть только у этих четырёх
скриптов, и только они пишут отслеживаемые файлы (проверено 24.09.2026;
`agent-stand.mjs` пишет pid-файлы, `audit-miscategorized-leads-23-09.mjs` —
разовый отчёт). Появится третий — дописать сюда строкой, иначе правило снова
станет неполным.

Живой случай по второму (#928, через час после #933, и это тот же класс):
в тему пришёл селектор `.rh2 .mh .grp:has(> .body)` коммитом `6d0c4cddd`,
`theme-2026-typeset.css` после этого не пересобрали, и `audit:typeset`
краснел у всех веток ровно так же, как до этого карта. Механика одна:
сгенерированный файл лежит в git, собирается из исходников, расходится
молча, и ни сборка, ни типы, ни тесты этого не видят.

**Прогон на своей копии отвечает про СВОЮ копию, а не про `main`** (24.09.2026,
разбор #891). Полный прогон идёт двадцать минут; за это время автор правки
успевает дописать то, чего прогон не нашёл. Вывод «этого нет в коде» верен на
момент форка и уже неверен на момент, когда его отправляют. Живой случай: на
сведении #891 упал `call-analysis-prior-contact.test.ts` (повторная системная
заметка «клиент уже обращался» не должна дублироваться за 14 дней), и в
`ai/callAnalysis.ts` на той копии дедупа действительно не было — а к моменту
вливания он там уже лежал, коммитом `6d0c4cddd`, и притом аккуратнее
задуманной замены. Чуть не появилась вторая реализация того же поверх готовой.

Поэтому: **перед тем как сказать «на `main` поломка» или «этого нет» —
перечитать ту голову, которая вливается, а не ту, с которой начинал.** Это
секунда работы (`git log -S "<имя>" -- <файл>` или просто `grep` по свежему
`main`) против починки, которая никому не нужна, и против ложной тревоги о
поломке на сайте.

**Тот же разбор дал и признак настоящего случая «тест есть, кода нет».**
Он бывает от сборки пачками: тест писал один исполнитель, код должен был
писать другой, и у каждой пачки в отдельности зелено. Выглядит как обычное
падение, и легко принять его за флак или за чужой регресс. Отличается тем,
что тест падает **и в одиночку, и на чистой базе**, а нужного кода нет в
файле, на который тест ссылается, **на вливаемой голове** — проверять именно
там, см. выше. Лечится дописыванием кода, а не откатом теста: тест здесь прав,
это ОН нашёл не-написанное.

Отсюда правило шире обоих признаков: **правку, собранную пачками у разных
исполнителей, нельзя считать проверенной по зелёным пачкам.** Зелёная пачка
говорит только о себе; половина механизма могла уехать в соседнюю. Полный
прогон на объединённой ветке — та самая последняя дверь перед сайтом, и для
такой правки он не формальность, а единственное место, где половинки
встречаются.

**Двенадцать файлов сервера, до которых не достаёт ни один тест** (замер
22.09.2026, `node scripts/impact-tests.mjs --for=<путь>`): `cron.ts`,
`worker.ts`, `env-check.ts`, `index.ts`, `ai/callInsights.ts`,
`lib/ads/adAlerts.ts`, `lib/autoResolveDuplicateErrors.ts`,
`lib/backfillJobApplications.ts`, `lib/geoMatchSweep.ts`,
`lib/lostInactiveTrashSweep.ts`,
`lib/telephony/pickAgentForLeadHook.ts`, `types/heic-decode.d.ts`. Это почти
целиком работа по расписанию — то есть ровно то, что идёт без человека и о
поломке чего узнают по последствиям, а не по красной проверке. Правишь любой
из них — тест пишется в той же правке, иначе проверка честно скажет «чисто»
про непроверенный код.

**Пересчёт 25.09.2026: осталось восемь.** `lib/recomputeJobPriorities.ts`
удалён правкой #943 — файла больше нет, и список о нём врал. Закрыты тестами в
тот же вечер: `lib/lostInactiveTrashSweep.ts` (#968), `lib/geoMatchSweep.ts`
(#969), `lib/autoResolveDuplicateErrors.ts` (#970),
`lib/telephony/pickAgentForLeadHook.ts` вместе с регистрацией крючков в
`index.ts` и `worker.ts` (этой правкой). `types/heic-decode.d.ts` — объявление типов,
проверять там нечего. Осталось по-настоящему: `cron.ts`, `env-check.ts`,
`ai/callInsights.ts`, `lib/ads/adAlerts.ts`, `lib/backfillJobApplications.ts`
плюс то, что в `index.ts` и `worker.ts` не сводится к регистрации крючков.

**Одно правило — одно место, и это место в `packages/shared`.** Найденный
живой пример (22.09.2026, правка #752): перевод суммы в сомони считался на
сервере через копейки с округлением, а на сайте умножением без округления, —
одна и та же сумма показывалась по-разному, и ни одна проверка этого не
видела, потому что каждая сторона была согласна сама с собой. Признак этого
класса: одинаковое ИМЯ функции или одинаковая КОНСТАНТА в `apps/api/src` и в
`apps/web/src`. Лечение одно: вычислимое правило переезжает в
`packages/shared`, обе стороны зовут его оттуда, и в `apps/api/tests` кладётся
тест, который сверяет обе стороны между собой (образец —
`apps/api/tests/money-shared-rule.test.ts`).

Чтобы новый двойник не появился молча, есть сторож: `npm run audit:rules`
(`scripts/audit-shared-rules.mjs`), шаг `precheck` и обеих проверок CI. Он не
сравнивает тексты — это делает `audit:dupes` и как раз НЕ ловит опасный случай:
у `toTjs` тексты были разные, в том и беда, а имя одно. Сторож ищет ИМЯ,
экспортируемое и из `apps/api/src`, и из `apps/web/src`, у которого нет общего
источника в `packages/shared`. Однофамильцы (серверная шина событий и очередь
загрузок сайта — обе с `subscribe`) вписываются в
`.shared-rules-baseline.json` **с причиной**; без причины запись не
принимается. Все пять найденных двойников перенесены правкой #752:
`toTjs` → `packages/shared/src/money.ts`, `distanceMeters` и
`parseWktPolygonRing` → `geo.ts`, `dushanbeDayKey` → `dushanbeDay.ts`,
`isDialableTajikNumber` → `tajikPhone.ts`. Старые модули переизлучают общие
функции, вызовы по коду не тронуты, обёртки сверяются с общей функцией тестом
`apps/api/tests/shared-rules-one-place.test.ts`. Осторожно: `export { X } from
"…"` НЕ вводит имя в область видимости файла — где имя используется внутри,
нужен ещё и `import`. В списке-исключении остаются настоящие однофамильцы
(`subscribe`, `suggestGeoAddress`) и `toTjs`: после переноса это две тонкие
обёртки над общим `convertToTjs`, каждая со своим способом взять курс.

### Дисциплина изменений

- Один модуль за задачу для одного исполнителя; много задач — много исполнителей
  параллельно (субагенты на Sonnet в `isolation: "worktree"`, по одной пачке
  каждому), а не один агент по очереди. «Отрефактори проект» даёт кашу и
  невозможный откат.
- После каждого шага `git diff --stat`; если тронуто больше файлов, чем в плане, — откат.
- Крупные правки разбивать: один шаг = одна ветка = один коммит.
- План и результаты аудита держать файлами в репозитории (`docs/`), а не в переписке:
  они переживают сессию, переписка — нет.
- **Перед тем как чинить находку из утреннего отчёта об ошибках или чужую жалобу —
  свериться со списком открытых PR** (`gh pr list --state open`, он же приходит в
  начале сессии хуком). Скорее всего находка уже оформлена веткой/черновиком.
  Правило добавлено 15.09.2026 — до него дважды чинили то, что уже лежало в
  открытом PR, вторым заходом с нуля.
- **Список открытых PR не ловит то, что ЕЩЁ НЕ НАЧАТО.** Задания в
  `docs/agent-briefs/*.md` для будущих или уже идущих параллельных worktree-сессий
  сами себе запрещают открывать PR заранее («не пушить, сборщик сольёт сам») — их
  не видно ни в `gh pr list`, ни в дереве `D:\CRM` (worktree — отдельная копия).
  Перед правкой нетривиального файла (владение клиентом, заявки на удаление,
  реактивация, `changeClientAgent`/спутники, что угодно в `services/leads/*`) —
  `grep -l "<имя файла>" docs/agent-briefs/*.md`. Правило добавлено 18.09.2026:
  нашёл и починил баг в `lib/ownershipSatellites.ts`, а в изолированном worktree
  в тот же момент уже лежало задание (`ownership-policy-a2-17-09.md`),
  переписывающее ровно этот участок — без проверки фикс рисковал молча
  потеряться при их слиянии, потому что тот агент читает `origin/main`, а не
  чужое незакоммиченное дерево.
- **Точечный фикс, задевающий область из уже выданного задания, не ждёт
  «сборщика» и общего пуша пачки — коммитится и пушится СРАЗУ, черновиком PR в
  тот же день.** Батч пушей (раздел «Дальше по скорости» выше) — экономия для
  СВОИХ, спланированных правок одного исполнителя; чужой worktree, идущий от
  `origin/main`, это незакоммиченное дерево не видит вообще, и единственный
  способ, которым он узнает про фикс, — его собственная ежедневная
  синхронизация `git fetch origin && git merge origin/main` («Работа вдвоём»
  ниже). Если фикса нет в `origin/main` до того, как чужое задание доедет до
  той же строчки — оно с высокой вероятностью молча воспроизведёт уже
  найденный баг, потому что писавший его агент о находке не узнает никак.

### Порядок работы (введён 07.09.2026 — выполнять без напоминаний)

**1. Список задач ведётся файлом `docs/TASKS.md`, а не в переписке.**
В начале сессии — открыть его первым делом. Каждая новая просьба владельца
попадает туда строкой СРАЗУ, до того как начал делать. Статусы обновляются
раз в пачку, вместе с коммитом, а не отдельными правками файла. Статусы: `[ ]` не начато,
`[~]` в работе, `[x]` сделано (с пометкой, чем проверено: ветка, тест, замер),
`[?]` ждёт решения владельца, `[!]` заблокировано чужим действием или доступом.
Разделы «Ждёт владельца» и «Заблокировано» существуют, чтобы вопрос не растворился
в переписке. В конце ответа владельцу — что вычеркнул, что добавил, что осталось.

**2. Нашёл баг — сразу искать ВЕСЬ его класс, в той же сессии.**
Отдельным агентом-разведчиком параллельно с починкой, а не «потом отдельной
задачей». Формулировать не «где ещё такой же файл», а «где ещё такой же механизм».
Проверено 07.09: починка одной осиротевшей заявки на удаление обернулась картой из
15 однотипных разрывов, из которых владелец видел один.
Частые классы в этом репозитории: защита подключена не во всех каналах/режимах;
спутник (заявка, требование, окно, ссылка) не гаснет при удалении родителя;
копия логики в моке вместо самой логики.

**0. Стенд агента поднимается ОДНОЙ командой (12.09.2026).**
```
node scripts/agent-stand.mjs up    --api 4730 --web 5230   # ссылки, клиент Prisma, своя база
node scripts/agent-stand.mjs serve --api 4730 --web 5230   # API и Vite, отвязанные от чата
node scripts/agent-stand.mjs down  --api 4730              # погасить своё
```
Контейнер Postgres ОДИН на всех (`rh-stand-pg`, порт 15500), агенту достаётся
своя база копией эталона: **2,6 секунды** вместо 3-4 минут, и памяти почти не
тратится. После новых миграций эталон пересобирается один раз на всех:
`node scripts/agent-stand.mjs refresh`. Серверы из `serve` переживают
перезапуск фоновой задачи чата (за ночь Vite умирал трижды посреди прогонов) и
гасятся по записанным идентификаторам, а не по строке поиска процессов.
Замер ночной смены 11→12.09: на этом рецепте каждый агент терял 10-20 минут и
половину граблей находил заново. В задании агенту достаточно одной строки со
ссылкой на этот скрипт.

**В веб-сессии (claude.ai/code) стенд поднимается САМ, ничего запускать не надо
(18.09.2026).** Там нет Docker, поэтому ни `docker compose`, ни `agent-stand.mjs`
не работают — вместо них при старте сессии отрабатывает хук
`.claude/hooks/session-start-stand.sh`: Postgres прямо из бинарников образа,
`apps/api/.env`, зависимости, клиент Prisma, миграции, `DATABASE_URL` в окружении
сессии. 35 секунд, после них `npm run test:api` запускается как есть. На машине
владельца хук выходит первой строкой и ничего не меняет. Подробности и грабли —
[docs/web-session-stand.md](docs/web-session-stand.md).

**«Cannot find package X» в свежей копии — это НЕ битая установка в общем дереве
(14.09.2026).** npm не поднимает в корневой `node_modules` пакеты, версии которых
конфликтуют между workspace, и держит их по месту: в `apps/api/node_modules` лежат
express 5 и его зависимости, в `apps/web/node_modules` — `@typescript-eslint/*`,
`@vitejs/plugin-react`, `@types/react-dom`, `ignore`. В корне их нет вовсе. Прежний
рецепт создавал `apps/<app>/node_modules` настоящей папкой ради одной ссылки на свой
`packages/shared` — и она заслоняла папку главного дерева, до которой поиск модулей
дальше не доходил. eslint, tsc и vite падали текстом, неотличимым от битой установки;
на этом за один день потеряли время двое. `setupTree()` теперь связывает каждый пакет
по отдельности, а `@royal-home/shared` оставляет своим — поэтому рецепт годится и для
задач, правящих `packages/shared`. Если такое всё же увидел: сначала проверь, не лежит
ли пакет ТОЛЬКО в `apps/*/node_modules` главного дерева, и лишь потом подозревай общую
установку.

**Сколько агентов разом.** Машина владельца: 6 ядер, 12 потоков, 16 ГБ. При
семи одновременных агентах 12.09 свободной памяти осталось 1,1 ГБ, и это было
причиной падающих dev-серверов и таймаутов e2e, а вовсе не «медленный код».
Потолок: **четыре агента разом**, пятый только если он без стенда. Перед
запуском пачки смотреть свободную память, а не только число задач.

**Дальше по скорости (то же измерение):** исполнителю НЕ поручать кадры и
глазами-проверки, они стоят ещё 10-20 минут; сборщик делает это один раз на
всю пачку. Пушить ветку один раз, когда она готова: каждый пуш перезапускает
десятиминутный прогон CI. Точное задание отдавать Sonnet, он в два-три раза
быстрее Opus; Opus — там, где надо придумывать форму.

**3. Чтение — агентами и параллельно, правки — тоже параллельно, но в
изолированных копиях.** Исследование кода параллелится идеально: шесть
агентов-разведчиков за девять минут делают дневную работу. Писать в ОДНО дерево
одновременно нельзя (сессии дерутся за файлы), поэтому правки раздаются
агентам на Sonnet в `isolation: "worktree"` пачками, каждому своя ветка, база
им не нужна (проверка сборкой); сборщик сливает ветки и проверяет один раз.
Так 10.09.2026 пять агентов закрыли 27 экранов за один вечер вместо недели.
Рецепт окружения в worktree (junction-ссылки на общий `node_modules`) — в задании
для агентов и в памяти `royalhome-artifact-port-step1-10-09.md`.
`npm install` в `D:\CRM` разрешён владельцем с 11.09.2026, но только сборщику и
только когда не запущены dev-серверы и агенты: корневой `node_modules` общий на
все worktree, частичная установка на минуту ломает всех. После установки —
`git status -- package-lock.json` и проверка junction `node_modules/@royal-home/shared`.

**4. Артефакты сборки — общие на все ветки, и это кусается.**
`packages/shared/dist` и сгенерированный клиент Prisma лежат вне git и не
переключаются вместе с веткой. Обязательны `npm run build:shared`,
`npx prisma generate` и `npx prisma migrate deploy` (последний — из `apps/api`,
из корня он не находит `datasource.url`) — иначе `tsc` падает на коде, который
совершенно исправен. Поймано дважды за 07.09.

**Не только после `git checkout` — после ЛЮБОГО изменения дерева** (уточнено
24.09.2026, семь случаев за один вечер на двоих). Артефакты собраны из дерева,
а не из имени ветки, поэтому `git merge origin/main`, `git pull` и подтягивание
свежего `main` в уже выбранную ветку ломают их ровно так же, как переключение.
Все семь случаев того вечера были после подтягивания `main`, ни одного после
`checkout` — то есть формулировка «после checkout» ловила как раз не тот
случай, который встречается. Три команды стоят полминуты, так что делать их
надо не по памяти о том, менялась ли схема, а безусловно перед прогоном.

**Признак, по которому это видно за пять секунд:** падает не утверждение
теста, а сам вызов — `TypeError: X is not a function`, `Cannot find module`,
«свойство не существует в типе». Тест до своей проверки не доходит вовсе, а
ошибки идут кучей в одном файле и про одно имя. Настоящий регресс выглядит
иначе: `expected … to be …`, то есть код отработал и вернул не то. Живые
случаи 24.09: `publishedPostLink is not a function` (устаревший
`packages/shared/dist`) и `videoHandoffQueuePauseReason does not exist in type`
вместе с `videoHandoffHeldAt`, `montajerDeliveredAt` (устаревший клиент
Prisma) — ни одно из них не утверждение, и каждое выглядело как поломка `main`.

### Время выката (решение владельца 03.10.2026)

Выкатывать на прод можно в **любое время суток и в любой день**, сразу как правки
готовы и проверены. Прежнее правило «только в нерабочее время» (11.08.2026) отменено:
его причину (конфликт имён контейнеров) устранили 13.08, а `ops/deploy.sh` и таймер
`royalhome-auto-deploy` (подхватывает `main` раз в минуту) делают выкат с проверками.
«Проверены» = сборка shared/api/web, тесты, ревью для крупного, ритуал после выката
(health 200, `/clients` = 401, `prisma migrate status`, три контейнера Up). Это решает
только время: проверки, ревью и осторожность с разрушающими операциями остаются.

### Работа вдвоём в одном репозитории (введено 10.09.2026 — обязательно обеим сторонам)

Над проектом работают двое, каждый со своим Claude, в один и тот же GitHub.
10.09 обнаружилось, во что это обходится без правил: шесть дней работы по логике
продавца (139 файлов, 13 000 строк, 15 миграций) лежали в одной ветке и не были
видны никому. PR под неё существовал, но его закрыли, а коммиты продолжили ложиться
в ту же ветку — **закрытый PR обратно не открывается**. За те же шесть дней `main`
ушёл вперёд на 472 коммита, и слияние стало давать 14 конфликтов.

1. **Ветка начинается с `git fetch origin` и растёт от свежего `origin/main`.** Не от
   вчерашнего локального `main` — от того, что в GitHub сейчас.
2. **PR открывается в первый же день, черновиком.** Не «когда доделаю». Черновик ничего
   не обещает, но с него работа видна в очереди и её проверяет CI.
3. **Один механизм = одна ветка = один PR.** Ветка на одиннадцать разных механизмов
   разбирается только целиком, а значит не разбирается никогда.
4. **Каждый день, пока ветка живёт: `git fetch origin && git merge origin/main`.**
   Отставание дешевле сводить по чуть-чуть; 400 коммитов разом уже никто не сводит.
5. **PR закрыт — ветка мертва.** Новая работа начинается новой веткой от свежего `main`.
   Закрыть PR и оставить ветку — та самая ловушка, из-за которой всё это написано.
6. **Ветку старше недели накладывать нельзя** (правило уже было): правка переносится на
   текущий код руками, PR закрывается ссылкой на новый коммит.
7. **Черновик PR без движения 3+ дня — либо домержить, либо закрыть** (введено
   15.09.2026). Черновик сторожа выглядит как «работа уже видна», но если по нему
   никто не двигается, он превращается в ту же зависшую ветку, только маскируется
   под живую — на 15.09 в очереди 29 открытых PR, 14 из них черновики сторожа.

За соблюдением следит `.github/workflows/sync-guard.yml` (сторож веток, каждую ночь):
ветке с коммитами и без открытого PR он заводит черновик сам, а открытым PR пишет,
насколько ветка отстала и какие файлы конфликтуют с `main` уже сегодня. Метка
`авто-синхро` на PR — сторож будет вливать `main` в ветку сам, пока слияние чистое.
Сторож никогда не мержит в `main`: выкат — решение владельца.

**Конфликты в общих «хвостовых» файлах (03.10.2026).** В `docs/product-*` (сгенерированная
карта) руками конфликт не разводят: `npm run ship` на шаге «свести» сам берёт версию `main`
и пересобирает карту `npm run map`, а при слиянии вручную — то же самое (`git checkout
--theirs` на эти файлы и `npm run map`). Список экспортов `packages/shared/src/index.ts`,
куда каждая фича дописывает строку `export * from "./x.js";`, защищён драйвером
`merge=union` в `.gitattributes`: две ветки, добавившие РАЗНЫЕ строки, сливаются без
конфликта (проверено на одноразовом репозитории), одинаковая строка не дублируется.
Оговорки: драйвер не работает с `git merge --no-attr` и в клоне, где `.gitattributes`
не подхватился (его нужно иметь в обеих сливаемых ветках и в рабочем дереве); слияние кнопкой
на сайте GitHub пользовательские атрибуты слияния может не учитывать (не проверялось); он не лечит
конфликты смысла — удалённую одной веткой и переименованную другой строку он оставит
обеими. Поэтому после слияния тест `apps/api/tests/shared-index-barrel.test.ts` проверяет
файл: нет маркеров конфликта, нет повторов, у каждой строки есть файл-цель.

### Резервное копирование и восстановление

Уже настроено, не выдумывать заново: `ops/backup.sh` (дамп Postgres + 4 тома,
офсайт в R2, крон `0 3 * * *`), `ops/restore-drill.sh` (еженедельная проверка,
что дамп реально восстанавливается). Все 4 сценария сбоя (VPS умер, база
повреждена, взлом, шифровальщик) с точными командами — [docs/archive/disaster-recovery.md](docs/archive/disaster-recovery.md).
RPO ≤24ч, RTO 1-4ч в зависимости от сценария.

### Ловушки этого репозитория

- **Акцент приложения СИНИЙ, шрифт ОДИН (с 21.09.2026).** Прежнее решение владельца
  «акцент графит, никаких синих кнопок» (11.09) он отменил сам: «Цвета синий хочу».
  Шрифтовая пара Manrope + Onest сведена к одному Onest («Б. Одно семейство делаем»).
  И то и другое задаётся в `apps/web/src/theme-2026-brand.css`, а НЕ в теме:
  `theme-2026-proto.css`, `theme-2026-mobile-home.css`, `theme-2026-wizard.css` и
  `theme-royal-home-2026.css` собираются скриптами из артефактов целиком, и правка
  в них исчезает при следующей синхронизации без единой ошибки. В старых заданиях
  под `docs/` строка «без синих кнопок» помечена как устаревшая — не следовать ей.
- **Размеры текста и гарнитура живут в собранном файле, а не в теме.**
  `npm run gen:typeset` собирает `apps/web/src/theme-2026-typeset.css`: 581 правило,
  повторяющее селекторы темы с поднятым размером (ничего мельче 13px) и с одной
  гарнитурой (49 правил темы называют "Manrope" прямо строкой, мимо токенов, —
  одними токенами семейство не свести). Причина та же: и размеры, и эти
  font-family лежат в генерируемых файлах. После пересинхронизации любого
  артефакта пересобрать, иначе часть экранов молча вернётся к мелкому шрифту и
  прежней гарнитуре; `npm run precheck` это ловит шагом `audit:typeset`.

- В `tailwind.config.js` акцент называется `blue` (это токен `--rgb-accent`), класса
  `accent` нет. Токены `--c-*` заданы без `<alpha-value>` — классы вида `bg-card/90`
  Tailwind не генерирует вообще, элемент остаётся без стиля.
- Атрибут `hidden` не скрывает элемент с классом `flex`/`grid`: правило `[hidden]`
  лежит в слое base, а `.flex` — в utilities ниже. Прятать условным рендером.
- Часовой пояс Душанбе UTC+5, контейнер живёт в UTC. Границы суток и месяцев —
  только через `lib/dushanbeTime.ts`, никогда через `setHours`.
- `undefined` не сериализуется в JSON: чтобы очистить поле через PATCH, слать `null`
  и разрешить его в Zod-схеме.
- **`\w` и `\b` в регулярках по русскому и таджикскому тексту молчат** (найдено
  20.09.2026, семь мёртвых правил в стражах бота). В JS `\w` — это `[A-Za-z0-9_]`
  даже с флагом `u`, а `\b` — граница между таким символом и любым другим. Поэтому
  `дом\b` не совпадает НИ С ЧЕМ, а `офис\w*\s+харид` ловит только форму без
  окончания. Брать `BW`/`EW`/`TAIL` из `ai/wordBoundary.ts`, а не `\w`/`\b`.
- **Номера и идентификаторы в тестах, собранные из `Date.now()` или `runId`,
  сталкиваются между файлами и на повторе прогона** (три живых падения 20.09.2026,
  правки #576 и #581). Разные выражения дают один и тот же номер (`89`+две цифры и
  `8`+три цифры — это один `8907`), а при `retry: 1` повтор идёт В ТОМ ЖЕ процессе с
  тем же `runId` и падает на своей же записи, прятав настоящую причину за ошибкой
  уникального индекса. Правила: номера сотрудников брать через
  `tests/helpers/extensionBase.ts` (полоса 1000-1099 — только для номеров, вписанных
  буквами), длину идентификаторов в одном файле держать одинаковой, а перед созданием
  своей записи убирать одноимённую.
- **Добавили вывоз (`export`) и вызов — проверьте подмены этого модуля в тестах.**
  `vi.mock("…", () => ({ … }))` без `importOriginal` отрезает модуль ЦЕЛИКОМ, и
  забытое имя валит прогон не в тесте, а внутри того файла, который его зовёт:
  «No "<имя>" export is defined on the mock». Красным становится не тот, кто менял
  код, а все открытые правки подряд. Поймано 20.09.2026 на
  `recordMontajerMessage` в `tests/telegram-agent-link.test.ts` (правка #584);
  под этой поломкой прятался ещё и устаревший текст расписки, невидимый, пока
  падала подмена. Искать так: `grep -rn '<имя модуля>' apps/api/tests`.
  С 01.10.2026 руками искать не нужно: **сторож `npm run audit:mocks`**
  (`scripts/audit-vi-mock.mjs`, шаг `precheck` и CI) не пропускает НОВУЮ
  фабричную подмену модуля из репозитория без `importOriginal`, если она отдаёт
  меньше имён, чем у модуля есть. Писать так:
  `vi.mock(путь, async (importOriginal) => ({ ...(await importOriginal<typeof import(путь)>()), …свои }))`.
  Старые узкие подмены — в `.vi-mock-baseline.json` (список только убывает;
  `systemError.js`, `ai/client.js`, `push.js` уже переведены); намеренно узкая
  подмена — раздел `intentional` той же базы, с причиной.
- **Тест, читающий запись, сделанную «в отрыве» (`void`, без `await`), гоняется с
  ней наперегонки.** `logAudit`/`logSystemAudit` (`lib/audit.ts`), `logSystemError`,
  отправка пушей намеренно не ждут вставку — горячий путь не должен от неё
  страдать. На свободной машине вставка успевает, и тест зелёный локально; на
  загруженном раннере — нет. С правки #608 тесты сервера идут в два процесса на
  одной базе, и падение стало живым: 21.09.2026 `card-auto-apply.test.ts` уронил
  чужую правку #616 дважды, хотя в одиночку давал 9 из 9. Красным при этом
  становится не тот, кто менял код. Читать такие записи только через
  `tests/helpers/waitFor.ts` (`waitFor`/`waitForCount`/`waitForSettled`), а не
  голым `findFirst` сразу после действия. Искать так:
  `grep -rln 'auditLog.findFirst\|auditLog.count' apps/api/tests`. Весь класс по
  `auditLog` вычищен 21.09.2026 (12 файлов) — при новых тестах помощник берётся
  сразу. Отдельный случай: проверка «ничего не записали» (`after).toBe(before)`)
  дождаться нечего, поэтому ОБА замера идут через `waitForSettled` — иначе
  запоздавшая запись проскочит мимо проверки.
- **Тест, который заводит заявку ботом и проверяет агента, зелёный только в
  рабочие часы.** Вне окна `Settings.workHoursStart/End` (по умолчанию
  09:30–18:00 по Душанбе, то есть после 13:00 UTC) заявка НАМЕРЕННО уходит в
  общую очередь без агента — `deferAssignment` в `messengers/conversation.ts`, —
  и вся лесенка назначения (`services/leads/assignment.ts`) не зовётся вовсе.
  Тест при этом падает на `assignReason`/`assignedAgentId`, и выглядит это как
  поломка кода: днём зелено, вечером красно, диффа нет. Поймано 23.09.2026 на
  `property-mention-routes-to-agent.test.ts` — падал и на `main`, и на всех
  ветках сразу. Лечение: фиксировать окно в `beforeAll`
  (`workHoursStart: "00:00"`, `workHoursEnd: "23:59"`) и возвращать в
  `afterAll`, как уже сделано в `website-webhook.test.ts`,
  `website-chat-widget.test.ts`, `website-lead-permanent-lock.test.ts`.
  Искать так: `grep -rln processMessengerTurn apps/api/tests` и среди них те,
  что проверяют `assignedAgentId`/`assignReason` без `workHoursStart`.
- **Тот же класс живёт и в ОЧИСТКЕ, не только в чтении** (найдено 22.09.2026,
  правка #739). `deleteMany` по такой таблице, стоящий внутри теста или в
  `beforeEach`/`afterEach`, гонится с записью соседнего теста ровно так же:
  чужая строка ложится ПОСЛЕ очистки и либо искажает подсчёт, либо — если у
  `logSystemError` совпал `dedupKey` — гасит уже нашу запись как повтор, и
  ждать её бесполезно. Поймано на `call-tracking.test.ts`: на main зелёный, на
  объединённой ветке красный. Лечение то же: `waitForSettled` с тем же `where`
  ПЕРЕД `deleteMany`. Безопасны очистка в `afterAll` (после всех тестов файла),
  очистка по идентификаторам, живущим внутри одного теста, и случай, когда
  пишущая функция вызывается через `await`.
