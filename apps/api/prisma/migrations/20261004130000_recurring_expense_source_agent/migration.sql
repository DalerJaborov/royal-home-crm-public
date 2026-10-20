-- 04.10.2026, CRM-07: шаблон повторяющегося платежа несёт канал рекламы и сотрудника,
-- ночная задача копирует их в создаваемый расход. Аддитивно: обе колонки nullable без
-- значения по умолчанию (старые шаблоны остаются с NULL и работают как раньше), таблица
-- небольшая (десятки шаблонов), перезаписи строк нет.
ALTER TABLE "RecurringExpense" ADD COLUMN IF NOT EXISTS "source" "ClientSource";
ALTER TABLE "RecurringExpense" ADD COLUMN IF NOT EXISTS "agentId" TEXT;
ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
