-- Ключ автоматической строки расхода (реклама за месяц, ИИ за месяц): делает
-- пересчёт идемпотентным — сколько бы раз ни прошла сверка, строка одна.
ALTER TABLE "Expense" ADD COLUMN "autoKey" TEXT;
CREATE UNIQUE INDEX "Expense_autoKey_key" ON "Expense"("autoKey");
