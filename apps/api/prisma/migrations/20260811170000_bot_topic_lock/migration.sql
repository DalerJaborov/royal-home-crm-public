-- Бот держит тему разговора (решение владельца 11.08.2026).
-- Состояние темы диалога: код темы, её подпись словами клиента, последний незакрытый
-- вопрос бота и счётчик ходов, на которых клиент этот вопрос обходит стороной.
-- Все колонки необязательные, счётчик с умолчанием — существующие диалоги продолжают
-- работать без единого изменения, а тема появляется у них с первого же нового хода.
ALTER TABLE "BotConversation" ADD COLUMN     "topic" TEXT,
ADD COLUMN     "topicLabel" TEXT,
ADD COLUMN     "openQuestion" TEXT,
ADD COLUMN     "topicSetAt" TIMESTAMP(3),
ADD COLUMN     "offTopicTurns" INTEGER NOT NULL DEFAULT 0;
