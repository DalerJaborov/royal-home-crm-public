# HANDOFF 2026-11-20: реестр строек memor.pro — сборка (продолжение)

Ветка `claude/memor-registry-0b7def`, worktree `D:\CRM\.claude\worktrees\pensive-golick-1b0039`. Разведка — `docs/HANDOFF_2026-11-20-memor-registry.md`; журнал — `docs/journal/2026-11-20-реестр-memor.md`. Ход работы — также `C:\Users\Daler\AppData\Roaming\Claude\side-session-notes\local_0a4c3338-5d99-46b3-b584-947604bb51e3\memor-registry-progress.md`.

## Готово и проверено
- Сервер: shared `constructionRegistry.ts`, 5 таблиц + миграция `20261120210000_construction_registry`, `apps/api/src/lib/constructionRegistry/{parse,sync,link,view}.ts`, `routes/constructionRegistry.ts`, cron `construction-registry-sync` (пн 04:30), рубильники `constructionRegistryEnabled/Notify` в Settings (zod в routes/settings.ts).
- Тесты (зелёные на стенде): `construction-registry-{rules,parse,sync-postgres,private}.test.ts`. Фикстуры — `apps/api/tests/fixtures/memor-*`.
- `npm run build:api` зелёный.
- Фронт пишет агент `coder`: `ConstructionPermitCard.tsx`, `useConstructionRegistry.ts`, `RegistrySettingsSection.tsx`, слой на `PropertiesMap/PropertyMapExplorer`, тест карточки. Проверить его отчёт и diff.

## Стенд
API 4741, Web 5241, база `agent_4741` (команды запуска — вывод `node scripts/agent-stand.mjs up --api 4741 --web 5241`; серверные переменные: DATABASE_URL=postgresql://postgres:postgres@localhost:15500/agent_4741, секреты стенда `stand-4741-*`). Первый настоящий забор запускался скриптом `apps/api/_firstsync.mts` (УДАЛИТЬ перед коммитом; он untracked).

## Осталось (по порядку)
1. Дождаться окончания первого забора (≈9 мин: 358 страниц × 1,5 с); проверить `select count(*), count("detailFetchedAt") from "ConstructionProject"` (ожидание 547 / ~358), `ConstructionSyncRun` (ok=true), сколько объектов связано автоматически.
2. Принять работу фронта: `npm run build:web`, `cd apps/web && npx vitest run`, `node scripts/theme-audit.mjs`; прочитать diff PropertyDetail/PropertiesMap/PropertyMapExplorer/DisciplineTab.
3. Поднять стенд (API + Vite), войти тестовой учёткой (+992900000000 директор; код стенд подставит сам, вход только формой), снять кадры карточки объекта (с привязкой, с предложением, «не найден») и карты со слоем: ПК 1440 и телефон 390, положить в `docs/journal/img/` или `docs/screens/` и сослаться из журнала. Для карточки нужен объект рядом с проектом реестра: создать в стенде объект с координатами проекта и адресом «Р. Набиев 12».
4. `npm run map`, затем `npm run map:check` и `npm run map:gate`; `npm run audit:*` по списку precheck (особенно `audit:rules`, `audit:limits`, `audit:fetch-timeout`, `audit:functions`, `audit:deps`, `audit:dead`).
5. `npm run precheck` зелёный (~1,5 мин+); `test:web`.
6. Ревью всего дифа агентом `architect` без контекста автора (проверить: гонки забора, права на смену привязки, утечки, N+1 в /map, фильтры), закрыть находки.
7. Коммит (две строки), `git push -u origin claude/memor-registry-0b7def`, черновик PR; выкат — только `npm run ship` из ОСНОВНОЙ папки `D:\CRM` (не из worktree), если основная папка на чужой ветке — по памяти `royalhome-ship-from-worktree-primary-busy-12-11`; push в main и merge-кнопка запрещены. На проде ничего вручную.
8. Отчёт владельцу простыми словами + блок «чего ещё не хватает».

## Что ещё стоит предусмотреть (для отчёта)
- Бот: «а застройщик надёжный?» — только цитатой реестра с датой; не делали, ждёт решения.
- Позвонить в управление: подтвердить «официальность» источника (домен .pro) до показа клиентам.
- Сторож «объект в продаже в красном блоке»; сводка по застройщикам; отчёт «наши объекты без разрешения».
- Если реестр изменит формат страницы — разбор вернёт пустое, виден сбой в журнале ошибок (сторож на пустой список есть, на пустые страницы нет: добавить счётчик).

## Обновление: фронтенд принят от агента (сборка и тесты зелёные)
Новые файлы apps/web/src: hooks/useConstructionRegistry.ts, components/ConstructionPermitCard.tsx (+ ConstructionPermitView), lib/registryMapFilter.ts, pages/settings/RegistrySettingsSection.tsx, components/__tests__/ConstructionPermitCard.test.tsx (13 тестов). Изменены: PropertyDetail.tsx (блок первым в promotionBlock, общий для ПК и телефона), PropertyMapExplorer.tsx (MapLibre: слои registry-projects и registry-rings, попап), PropertiesMap.tsx (кнопка слоя «Реестр строек», сегмент «Разрешение», подпись), themeMapColors.ts, settings/DisciplineTab.tsx (секция в «Дисциплине»). Проверено агентом: build:web, tsc, eslint, vitest 105 зелёных, theme-audit 0. НЕ проверено глазами: карта со слоем, секция настроек, «Забрать сейчас» — нужны кадры. Риск: цвета колец реестра совпадают с цветами цены на карте; если путаница на кадре — менять форму/цвет кольца.
Отдельно: проверить результат забора `_firstsync.mts` (лог в scratchpad `firstsync.log`), затем удалить `apps/api/_firstsync.mts`.
