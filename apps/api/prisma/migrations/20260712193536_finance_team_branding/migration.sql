-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('ADVERTISING', 'SALARY', 'OFFICE', 'OTHER');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "lastSeenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "companySlogan" TEXT NOT NULL DEFAULT 'Агентство недвижимости';

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "source" "ClientSource",
    "agentId" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'TJS',
    "month" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Expense_month_idx" ON "Expense"("month");

-- CreateIndex
CREATE INDEX "Expense_category_month_idx" ON "Expense"("category", "month");

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
