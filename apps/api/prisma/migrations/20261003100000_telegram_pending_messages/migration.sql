-- Склейка быстрых сообщений в Telegram (ночная проверка, находка №132, 01.10.2026):
-- тот же буфер окна ожидания, что у "BotConversation" (миграции
-- 20260719140347_bot_debounce_buffer и 20260731090000_bot_followups).
-- Только добавление колонок — с умолчанием или пустых, существующие строки не меняются.
ALTER TABLE "TelegramConversation" ADD COLUMN "pendingMessages" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "TelegramConversation" ADD COLUMN "pendingAttachments" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "TelegramConversation" ADD COLUMN "pendingSince" TIMESTAMP(3);
