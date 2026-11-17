# 17.11.2026 — выгрузка пар «клиент → шаблон → модель» работает на сервере

## Что изменилось
- Скрипт выгрузки перенесён из `apps/api/scripts/` в `apps/api/src/scripts/export-answer-samples.ts`: он собирается вместе с API и лежит в образе как `dist/scripts/export-answer-samples.js`.
- Команда на сервере: `docker compose exec api node dist/scripts/export-answer-samples.js --limit=30` (только чтение, Markdown). `tsx` в рабочие зависимости не добавлялся.

## Почему
Образ api копирует только `dist`, `prisma`, `assets`, а после `npm prune --omit=dev` в нём нет `tsx`: прежняя команда `npx tsx scripts/…` на сервере не работала (замечание проводника к #240).

## Чем проверено
- `build:api`: файл `dist/scripts/export-answer-samples.js` появляется; запуск собранного скрипта на тестовой базе печатает пары; `precheck --no-tests`.
