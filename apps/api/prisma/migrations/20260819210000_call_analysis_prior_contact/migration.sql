-- Сигнал «клиент уже обращался раньше» — модель ставит его, читая расшифровку,
-- триггер для проверки похожих карточек (владелец 19.08.2026).

-- AlterTable
ALTER TABLE "CallAnalysis" ADD COLUMN     "mentionsPriorContact" BOOLEAN NOT NULL DEFAULT false;
