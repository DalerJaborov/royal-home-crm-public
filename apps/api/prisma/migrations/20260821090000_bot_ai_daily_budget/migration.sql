-- Суточный бюджет ходов ИИ на один диалог (решение владельца 21.08.2026).
-- Аддитивно: только новые колонки с умолчаниями, ничего не удаляется и не
-- переписывается. Старые диалоги получают aiBudgetDate = NULL — это читается
-- как «счётчиков за сегодня ещё нет», и первый же ход заводит их сам.
ALTER TABLE "BotConversation" ADD COLUMN "aiBudgetDate" TEXT;
ALTER TABLE "BotConversation" ADD COLUMN "aiTurnsToday" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BotConversation" ADD COLUMN "aiFilesToday" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BotConversation" ADD COLUMN "aiLimitNoticeAt" TIMESTAMP(3);
