-- Кто поставил паузу бота ответом из CRM (26.11.2026): чужую более длинную паузу выбранный срок не укорачивает.
ALTER TABLE "BotConversation" ADD COLUMN "botPausedBy" TEXT;
ALTER TABLE "TelegramConversation" ADD COLUMN "botPausedBy" TEXT;
