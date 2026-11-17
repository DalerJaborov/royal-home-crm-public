# 16.11.2026 — один мозг, шаг 2: одна дверь к старому боту, рубильник и тень по каналам

Источник: решение владельца 16.11 («один мозг»), план `reports/one-brain-plan-2026-11-16.md` (вне репозитория), шаг 1 — PR #211.

## Что сделано
1. `ai/legacyQualifyDoor.ts` — единственная дверь к старому боту (`leadQualifier.ts`). Через неё идут все 6 вызывающих:
   `messengers/conversation.ts` (Meta-DM полосы LEGACY, сайт, YouTube), `messengers/customerQualifierTurn.ts`,
   `telegram/bot.ts`, `messengers/telegramDirectMessages.ts`, `jobs/telegramReplyRetry.ts`, `jobs/telegramDirectReplyRetry.ts`;
   и помощники (`replyChain.ts`, `botAudit.ts`, `routes/settings.ts`, скрипт `backfill-extra-phones-from-notes.ts`).
2. `lib/customerAgentChannelSwitch.ts` — рубильник по каналу: `CUSTOMER_AGENT_CHANNEL_SHADOW=meta_dm,arvan,website,youtube,telegram`
   (или `all`). Пусто (по умолчанию) — ровно как раньше, ни одного лишнего чтения или вызова модели.
   Значения `live` нет намеренно: для Meta-DM и комментариев IG/FB уже есть дверь `rolloutConfig.allowed`
   (+ `CUSTOMER_AGENT_LEGACY_CUTOVER`); для Telegram/сайта/YouTube у ядра нет транспорта.
3. `lib/customerAgentLegacyShadow.ts` — тень: после ответа старого бота ядро считает ход на тех же словах (только чтение:
   публичные инструменты, без записи и без `get_property_facts`; `sayMode: shadow`), обе оценки — в одну запись
   BotTurnTrace (`managed.phase = "shadow"`, поле `legacyShadow`: ответил ли, просил ли номер, действие; без текста).
   Фоном, не задерживает и не меняет ответ клиенту; не больше 2 одновременно и 200 в сутки (`CUSTOMER_AGENT_SHADOW_DAILY_CAP`).
   Повторы того же хода (регенерация, фоновые повторы, оплаченный повтор) тень не запускают.
4. Схема трассы (`packages/shared/src/botTurnTrace.ts`): каналы TELEGRAM/YOUTUBE (только для записи тени), фаза `shadow`,
   `traceLegacyShadowSchema`.
5. Сторож CI `tests/one-brain-legacy-door-guard.test.ts`: никакой рабочий файл, кроме двери, не импортирует `leadQualifier`
   и не вызывает `runQualifyTurn`.

## Факты (прод, только чтение, 16.11)
- `rolloutConfig.allowed`: Royal Home IG/FB/WA DM, Royal Home Info IG DM, комментарии IG Royal Home. Арван (IG/FB DM,
  комментарии IG) и комментарии FB — НЕ в списке → идут старым ботом/старым генератором.
- Имя бренда в ядре уже есть (`MessengerAccount.brandName` → `customerCompanyInformation`).
- Личность из Настроек (`Settings.botSystemPrompt`) пуста; своя личность есть только у Royal Home Info (2881 знак) —
  этот аккаунт уже в ядре, и ядро её не читает (так и до этой правки).
- Telegram: бот — 10 диалогов всего, 5 за неделю; личные сообщения Telegram (`TelegramDirectConversation`) — 0 за всё время.

## Не сделано
- Живой режим Telegram/сайта/YouTube через ядро — нужен транспорт и вход (principal) ядра для этих каналов.
- Шаг 3 (удаление `leadQualifier.ts`) — небезопасно, пока Telegram/сайт/YouTube говорят только старым ботом.
