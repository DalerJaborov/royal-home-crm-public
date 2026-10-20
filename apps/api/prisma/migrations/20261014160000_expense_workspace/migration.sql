-- Historical records retain PAID and unknown actual payment dates remain NULL.
ALTER TABLE "Expense" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PAID', ADD COLUMN "paymentDate" TIMESTAMP(3), ADD COLUMN "counterparty" TEXT, ADD COLUMN "paymentMethod" TEXT, ADD COLUMN "categoryId" TEXT, ADD COLUMN "createdById" TEXT, ADD COLUMN "exchangeRate" DECIMAL(65,30), ADD COLUMN "requestKey" TEXT, ADD COLUMN "recurringId" TEXT, ADD COLUMN "occurrenceDate" TEXT;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_status_check" CHECK ("status" IN ('PAID','PLANNED'));
CREATE UNIQUE INDEX "Expense_requestKey_key" ON "Expense"("requestKey");
ALTER TABLE "Expense" ADD COLUMN "rateCapturedAt" TIMESTAMP(3);
ALTER TABLE "RecurringExpense" ADD COLUMN "period" TEXT NOT NULL DEFAULT 'MONTH', ADD COLUMN "startsOn" TEXT, ADD COLUMN "endsOn" TEXT, ADD COLUMN "autoPay" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "skippedDates" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], ADD COLUMN "counterparty" TEXT, ADD COLUMN "paymentMethod" TEXT, ADD COLUMN "categoryId" TEXT;
CREATE TABLE "ExpenseCategoryDefinition" ("id" TEXT NOT NULL, "title" TEXT NOT NULL, "rootCategory" "ExpenseCategory" NOT NULL, "parentId" TEXT, "icon" TEXT NOT NULL, "color" TEXT NOT NULL, "budgetMonthly" DECIMAL(65,30), "active" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ExpenseCategoryDefinition_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ExpenseReceipt" ("id" TEXT NOT NULL, "expenseId" TEXT NOT NULL, "fileName" TEXT NOT NULL, "originalName" TEXT NOT NULL, "mimeType" TEXT NOT NULL, "size" INTEGER NOT NULL, "uploadedById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ExpenseReceipt_pkey" PRIMARY KEY ("id"));
CREATE INDEX "ExpenseReceipt_expenseId_idx" ON "ExpenseReceipt"("expenseId");
ALTER TABLE "ExpenseReceipt" ADD CONSTRAINT "ExpenseReceipt_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecurringExpense" ADD COLUMN "deletedAt" TIMESTAMP(3);
INSERT INTO "ExpenseCategoryDefinition" ("id","title","rootCategory","icon","color","updatedAt") VALUES
('00000000-0000-4000-8000-000000000001','Реклама','ADVERTISING','Megaphone','#E67555',CURRENT_TIMESTAMP),
('00000000-0000-4000-8000-000000000002','Зарплата','SALARY','Users','#8C78B9',CURRENT_TIMESTAMP),
('00000000-0000-4000-8000-000000000003','Офис','OFFICE','Building2','#4E9E88',CURRENT_TIMESTAMP),
('00000000-0000-4000-8000-000000000004','Прочее','OTHER','Ellipsis','#7F97B4',CURRENT_TIMESTAMP);
