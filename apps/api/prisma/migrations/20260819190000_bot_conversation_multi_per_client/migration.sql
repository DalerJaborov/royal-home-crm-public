-- Снимаем ограничение "один диалог бот-платформы на карточку клиента"
-- (владелец 19.08.2026): клиент мог написать в Instagram, потом позвонить и
-- получить просьбу написать в WhatsApp — вторая переписка физически не могла
-- привязаться к той же карточке. Звонки (Interaction) такого ограничения не
-- имели никогда; теперь переписка ведёт себя так же.

-- DropIndex
DROP INDEX "BotConversation_clientId_key";

-- CreateIndex
CREATE INDEX "BotConversation_clientId_idx" ON "BotConversation"("clientId");
