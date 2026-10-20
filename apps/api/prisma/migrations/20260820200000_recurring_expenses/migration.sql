-- Повторяющиеся платежи: шаблон, из которого крон каждый месяц заводит обычную
-- строку расхода и напоминает о сроке оплаты. Ничего в существующих данных не меняет.
CREATE TABLE "RecurringExpense" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL DEFAULT 'OFFICE',
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'TJS',
    "dayOfMonth" INTEGER NOT NULL,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastCreatedMonth" TEXT,
    "lastRemindedMonth" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringExpense_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RecurringExpense_active_idx" ON "RecurringExpense"("active");
