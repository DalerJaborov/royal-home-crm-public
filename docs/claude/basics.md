# Проект, структура, порядок любой правки

> Перенесено дословно из корневого CLAUDE.md 01.11.2026 (сокращение стартового контекста). Короткая выжимка правил осталась в CLAUDE.md; здесь — полный текст.

<!-- CLAUDE.md (до 01.11.2026), строки 1–72 -->
# CLAUDE.md — Royal Home CRM

Guidance for Claude Code when working in this repository.

## Current public workflow — 21.10.2026

The active source is `DalerJaborov/royal-home-crm-public`, with independent clean
history. Follow the public-repository section in AGENTS.md: `npm run ship` runs
source checks and, when required, the complete API suite on GitHub-hosted Linux.
No local PostgreSQL/build is needed for that default path; `--local-tests` is
the explicit fallback. Do not merge old private history into this repository.
The production checkout `/opt/royalhome-crm` must track this public repository.
Verify its origin, deployed SHA and API/worker health separately; do not
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

