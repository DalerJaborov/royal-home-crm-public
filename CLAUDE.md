# CLAUDE.md — Royal Home CRM

Монорепо npm workspaces, TypeScript, Node 24, только npm:
`apps/api` (Express, Prisma/PostgreSQL, JWT+bcrypt, zod, multer, sharp),
`apps/web` (React 18 + Vite + Tailwind + PWA, React Router, TanStack Query, Zustand, dnd-kit, lucide),
`packages/shared` (Zod-схемы и типы для обоих — один источник, типы не дублировать).
`@royal-home/shared` собирается в `dist/`: после правки `packages/shared/src` — `npm run build:shared`.

Полный текст правил и разборы — в `docs/claude/*.md`. Здесь выжимка; файл темы читать, когда задача её касается.

## Рабочий процесс публичного репозитория (с 21.10.2026)

Источник — `DalerJaborov/royal-home-crm-public` (чистая история). Следовать разделу про публичный репозиторий в `AGENTS.md`: `npm run ship` гоняет проверки исходников и при необходимости полный набор API на GitHub-hosted Linux; локальные Postgres/сборка для этого пути не нужны (`--local-tests` — явный запасной вариант). Старую приватную историю не вливать. Прод-чекаут `/opt/royalhome-crm` должен смотреть на этот репозиторий; origin, выкаченный SHA и здоровье API/worker проверять отдельно — «выкачено» не по факту мержа на GitHub. Описания self-hosted-раннера и выката ниже и в `docs/claude/` — прежняя схема.

## Ни ключей, ни номеров клиентов в репозитории (с 20.10.2026, железно)

- Не коммитить ключи, токены, пароли, `.env`/`.env.*` (кроме `*.example`), SSH-ключи, сертификаты, дампы базы, выгрузки клиентов. Секрет — в `.env` на сервере или в Настройках CRM; в коде и тестах только заглушки (`change-me…`, `test-…`, `stand-…`).
- Номер клиента/сотрудника в `docs/`, `*.md`, разборах и журналах — только маской `+992•••••3726`; вместо имени рядом — «клиент ПК-000463».
- Держат машины: `.githooks/pre-commit` и `audit:secrets` в `precheck`/`ship` (`scripts/audit-secrets.mjs`; ложная тревога — `secret-scan: allow` с причиной в той же строке; `--mask-docs` маскирует номера).
- Ключ попал в коммит или пуш — он утёк: сказать владельцу, сменить у сервиса; удаление из файла не спасает.

## Порядок любой правки

1. `git fetch origin main`, своя ветка от свежего `origin/main`; `npm run build:shared && npm run prisma:generate`.
2. До правки: `npm run where -- --file <путь>` (кто зависит) и `node scripts/impact-tests.mjs --for=<путь>`; зависимых не ломать. Нашёл баг — ищи тот же механизм рядом, на телефоне и на ПК. Убирать только то, что просили.
3. После: тест на починку; `npm run map` → `npm run map:check`; `npm run precheck` зелёный; запись `docs/journal/ГГГГ-ММ-ДД-о-чём.md`.
4. Коммит, `git push -u origin <ветка>`, черновик PR.
5. На сайт — только `npm run ship` из основной папки (не из worktree). «Влей / на сайт / выкати» — чат запускает `npm run ship` сам. Одна ship за раз; «main ушёл вперёд» — заново; красный — чинить и заново, не обходить. `--dry-run` — план, `--no-merge` — без вливания.
6. Никогда: кнопка merge на GitHub, `merge_pull_request`, `gh pr merge`, `git push` в `main`, строка `Ship-Verified` руками.

## Прод

Сервер сам берёт вершину `main` со строкой `Ship-Verified` (таймер `royalhome-auto-deploy`, раз в минуту) — GitHub Actions в выкате не участвует, не обещать «запущу выкат в Actions». Выкатывать можно в любое время, как только проверено. Не трогать `.env.production*` и файлы репозитория на сервере. Из веб-сессии `crm.royalhome.tj` недоступен (403 ≠ «сайт лежит») — судить по `journalctl -u royalhome-auto-deploy`, глазами просить владельца. Подробно, команды сервера, замок выката → `docs/claude/ship-and-deploy.md`.

## Команды (из корня)

`docker compose up -d` (Postgres) · `npm run build:shared|build:api|build:web|build` · `npm run dev:api|dev:web` · `npm run test:api` (нужна база) · `npm run test:web` (без базы) · `npm run prisma:generate|prisma:migrate|prisma:seed` · `npm run map|map:check` · `npm run precheck` · `npm run sync:main` · `npm run ship`. Полный список → `docs/claude/commands.md`.

## Проверка перед «готово»

- «Готово» — только при нулевом коде возврата. Вывод команд показывать только когда упало (само падение, не весь лог); зелёное — одной строкой.
- Перед пушем — `npm run precheck` (~1,5 мин: сборки с eslint, `audit:*`, `map:check`, `map:gate`, тесты, задетые по графу импортов).
- Тронул `apps/web` — ещё `npm run test:web`: сборка тестов фронта не видит.
- Исполнитель пачки — сборка и точечные тесты: `cd apps/api && npx vitest run <файлы>` (не `--root` из корня — не найдёт `.env`). Полный `test:api` гоняет один раз `npm run ship` (агент его не запускает); smoke e2e и кадры — раз на пачку у сборщика. Зелёные пачки по отдельности не доказывают объединённую ветку.
- Чего тесты не ловят: экран после правки фронта, атомарность (`$transaction`), N+1, таймауты внешних вызовов + `logSystemError`, предел выборки, идемпотентность вебхуков.
- Падает сам вызов (`X is not a function`, `Cannot find module`, «нет свойства в типе»), а не утверждение — устарели артефакты: `npm run build:shared`, `npx prisma generate`, `cd apps/api && npx prisma migrate deploy`. Делать безусловно после ЛЮБОГО изменения дерева (checkout, merge, pull).

Подробно → `docs/claude/verification.md`.

## Чтобы правка здесь не ломала там

- Ошибку сборки не гасить расширением типа (`as`, `any`, `?` на общем поле). Правка `packages/shared` обязана пройти и `build:api`, и `build:web`.
- Правило, которое считают обе стороны, живёт одно в `packages/shared` (сторож `audit:rules`).
- Сгенерированные файлы в git руками не правятся: `npm run map` → `docs/product-*`, `npm run gen:typeset` → `apps/web/src/theme-2026-typeset.css`. После любого вливания/свода пересобрать оба, потом `map:check` + `audit:typeset`; красный сторож на `main` — чинить вне очереди.
- Свод с `main` — `npm run sync:main`; после ручного конфликта — `node scripts/sync-main.mjs --continue`. Развёл конфликт в тесте — прогони этот тест руками (precheck его не видит). После свода TS2459/TS2305 — имя переехало: `git log -S "<имя>"` по свежему `main`, импорт перевести на новое место.
- Файлы-склады (`SECRET_SETTINGS_FIELDS`, `test:scripts` в `package.json`) сводить объединением обеих сторон.
- Перед словами «на main поломка» / «этого нет» — перечитать вливаемую голову, а не свою копию.
- Новый сторож проверять, внеся ту поломку, которую он обязан ловить.
- `vi.mock` модуля из репозитория — только с `importOriginal` (сторож `audit:mocks`).

Подробно, шесть слоёв и слепые пятна → `docs/claude/change-safety.md`; карта и `where` → `docs/claude/product-map.md`.

## Журнал и задачи

- Начало сессии — `docs/JOURNAL.md` и `docs/TASKS.md`. Новая просьба владельца — строкой в `TASKS.md` сразу (`[ ]` `[~]` `[x]` `[?]` `[!]`), статусы — раз в пачку.
- Каждая правка кода или решение → файл `docs/journal/ГГГГ-ММ-ДД-о-чём.md` (сторож `journal-gate`; не нужна — метка «журнал-не-нужен» / `JOURNAL_GATE_SKIP=1`). Новое решение владельца — ещё строкой в `docs/JOURNAL.md`, раздел «Решения».

## Работа вдвоём и агенты

- Перед починкой находки: `gh pr list --state open` и `grep -l "<файл>" docs/agent-briefs/*.md` — может, уже делается. Фикс в области чужого выданного задания — пушить сразу, черновиком PR.
- Один механизм = одна ветка = один PR; черновик PR в первый день; каждый день `git merge origin/main`; PR закрыт — ветка мертва; ветку старше недели не накладывать; черновик без движения 3+ дня — домержить или закрыть.
- Параллельные правки — только в worktree; в основном дереве работает один исполнитель. Не больше 4 агентов со стендом разом (16 ГБ). `npm install` в `D:\CRM` — только сборщику, когда никто не работает.
- Стенд: `node scripts/agent-stand.mjs up|serve|down --api <порт> --web <порт>`; в веб-сессии его поднимает хук сам.

Подробно → `docs/claude/workflow-agents-stand.md`.

## Код и интерфейс

- Zod на каждом внешнем входе; правильные коды и структурные ошибки; внешние вызовы с таймаутом, ошибки не глотать; секреты только в `.env`; загрузки и пути санировать.
- Mobile-first. Функция экрана — сразу для ПК и телефона: есть `components/mobile/Mobile*.tsx` со своей логикой — добавить и туда (идиома `.pg-h .sec-t .card .list .row .chip .quiet`); только дублирует разметку — удалить.
- Акцент синий, шрифт один (Onest) — правится в `apps/web/src/theme-2026-brand.css`. `theme-2026-proto.css`, `-mobile-home.css`, `-wizard.css`, `theme-royal-home-2026.css` генерируются из артефактов — правка в них пропадёт.
- Время — Душанбе UTC+5; границы суток/месяцев только через `lib/dushanbeTime.ts`.
- Скрипты на Node: `spawn`/`execFile` для `.cmd` (`npx`, `npm`) — с `shell: true`; сравнение файлов — нормализовать `\r\n`.
- Остальные ловушки (Tailwind `blue` и `bg-card/90`, `[hidden]` + `flex`, `\w`/`\b` по кириллице, `null` в PATCH, `waitFor` для записей «в отрыве», рабочие часы в тестах бота, номера в тестах) → `docs/claude/repo-traps.md` — читать перед тестами и правкой UI.

## По задаче

- CI, workflow, Windows-раннер → `docs/claude/ci-windows-runner.md`
- Код, который вызывает Claude API (ID моделей, параметры) → `docs/claude/ai-models-and-tokens.md`
- Стандарты кода целиком → `docs/claude/working-standards.md`
- Бэкапы и восстановление → `docs/claude/backup.md`
- История и разборы случаев → `docs/claude/history.md`
