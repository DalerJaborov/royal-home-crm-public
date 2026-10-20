-- Бэкфилл для существующих Telegram-диалогов: lastMessageAt появился в предыдущей
-- миграции и у старых записей NULL. Без бэкфилла инбокс подставляет updatedAt,
-- который бампится любым апдейтом (пауза, readAt) — старый диалог выглядел бы
-- ложно «непрочитанным» и всплывал бы наверх списка.
UPDATE "TelegramConversation" SET "lastMessageAt" = "updatedAt" WHERE "lastMessageAt" IS NULL;
