-- 04.10.2026, CHANNEL-NEW-23: комментарий группы-обсуждения Telegram помнит свою группу.
-- message_id нумеруется внутри чата, поэтому ключ идемпотентности становится парой
-- (groupChatId, messageId). Колонка nullable без значения по умолчанию: старые строки
-- остаются с NULL и работают по прежнему правилу (запасной поиск по messageId в коде).
-- Таблица небольшая (комментарии одной группы), блокировка на создание индекса короткая.
-- Порядок важен: новый уникальный индекс создаётся ДО удаления старого, чтобы ни на
-- миг приём не остался без защиты от повторной доставки. Старый индекс строго уже
-- нового (messageId уникален глобально), поэтому создание нового не может упасть
-- на существующих данных.
ALTER TABLE "TelegramGroupComment" ADD COLUMN IF NOT EXISTS "groupChatId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramGroupComment_groupChatId_messageId_key" ON "TelegramGroupComment"("groupChatId", "messageId");
DROP INDEX IF EXISTS "TelegramGroupComment_messageId_key";
