-- Режим «только заявки» (второе ревью 13.11.2026): о чём бот попросил номер.
-- Только добавление пустой колонки: старые строки остаются NULL, поведение
-- выключенного режима не меняется. Пишет и читает lib/leadOnlyPending.ts.
ALTER TABLE "BotConversation" ADD COLUMN "leadOnlyPending" JSONB;
