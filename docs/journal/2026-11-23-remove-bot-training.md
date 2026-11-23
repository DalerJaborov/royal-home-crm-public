# 23.11.2026 — «Обучение бота»: PR #169 доведён до свежего main

**Решение владельца** (23.11): «удали» — довести черновик PR #169 и убрать «Обучение
бота» целиком. Первоначальный разбор — `2026-11-13-remove-bot-learning.md`.

## Свод с main (207 коммитов)

- Ветка `claude/remove-bot-learning-13-11` сведена с `origin/main` (90aba6a8).
- Удалённые в PR файлы, которые main успел поменять (`ai/botAudit.ts`,
  `ai/agencyFactsLessons.ts`, `BotTrainingPanels`, `BotTrainer`, `AiLearning`,
  `bot-audit-phone-mask.test`) — остаются удалёнными.
- Взято у main и сохранено: проверка закрытого окна мессенджера до отправки
  (`windowClosedBeforeSend` в `conversationDelivery.ts`), правило «только заявки +
  номер WhatsApp» в промте (`leadQualifier.ts`), снятие источника штрафов Royal
  Score в «Инсайтах» и снятые им же кроны/пути (`silentClientAutoDeactivate`,
  `lostInactiveTrashSweep`, `/api/v1/ui-shell/config` в обслуживании настроек).
- «Инсайты от ИИ» теперь собирают кандидатов из двух источников: слабые звонки и
  положительные. Штрафы сняты 16.11, судья диалогов — вместе с этой правкой.

## Что main успел добавить к удаляемому — убрано здесь

- «Новый вид»: оценка «Верно/Неверно» в шторке «Сведения о сообщении»
  (`RoyalMessageInfo` + стили `.ry-msg-info-rate`), значок пункта `/ai-learning`,
  экран «Обучение бота» в тестах экранов контроля и e2e (`new-look-control`,
  `-geometry`, `-tones-errors`), подставные ответы `/bot-learning`, `/bot-audit`,
  `/bot-training` в `overflow-audit.mjs`, `unresolvedFindings` в фикстурах.
- Сторожа: `ai/botAudit.ts` в списке исключений `bot-answers-itself-guard`,
  `pages/AiLearning.tsx` в `HIDING_PAGES` и шесть строк долга в
  `loadErrorGuard.baseline.json`, мок `lib/botLessons.js` в
  `whatsapp-24h-window-quiet.test`.
- `screens.generated.ts`: сняты только `/ai-learning` и `/bot-training`. Файл
  отстаёт от `App.tsx` и на main (нет `/pult`, `/backups`, `/stuck-work` и др.;
  `npm run screens` даёт +14/−4) — полную перегенерацию не делал, это отдельная
  правка утреннего отчёта о непосещённых экранах.

## Миграция

- Переименована в `20261123120000_drop_bot_learning` (была `20261113…`, раньше
  двух десятков миграций main). На проде её не было (`_prisma_migrations` пуст по
  `%bot_learning%`, проверено 23.11).
- Снимает пять таблиц: `BotLesson` 515 строк, `BotAuditFinding` 4340,
  `LostConversation` 263, `LostClientDigest` 5, `StyleExample` 186 (прод, 23.11).
  Таблицы пополнялись до сегодняшнего утра — выгрузка 13.11 их уже не покрывает:
  перед выкатом снять дамп этих таблиц.
- `Settings.botTrainingScreenEnabled` **оставлена** на один выкат: `ops/deploy.sh`
  применяет миграции, пока старые api/worker ещё работают (3–15 с по журналу
  выкатов 22.11), а их Prisma читает Settings всеми колонками — снятая колонка
  уронила бы каждое чтение настроек на это время. Код поле не читает; снять
  отдельной миграцией следующим выкатом.
- `prisma migrate diff` после `migrate deploy` на отдельной базе стенда пуст.

## Проверено

- `tsc --noEmit` api и web — чисто (shared из этой же ветки).
- `npm run test:web` — 3314 из 3316; два красных починены (долг loadErrorGuard,
  таймаут noLeadWord под нагрузкой — отдельно зелёный).
- API на отдельной базе `agent_pr169`: тесты, задетые по графу импортов, плюс
  инсайты, обслуживание настроек, окно WhatsApp, журнал расследований, сверка
  схемы с миграциями, режим «только заявки» — зелёные.
- `npm run map` / `map:check` — совпадают.
