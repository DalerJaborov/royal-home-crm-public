-- Объект, по рекламе которого человек написал: должен дожить до хода, на котором
-- клиент ответит на нейтральный вопрос бота. См. messengers/conversation.ts.
ALTER TABLE "BotConversation" ADD COLUMN "adPropertyId" TEXT;
