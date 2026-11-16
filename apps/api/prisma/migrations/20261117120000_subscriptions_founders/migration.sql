-- Подписки с поставщиком и взносы учредителей (17.11.2026). Только добавления.
ALTER TABLE "Expense" ADD COLUMN "vendor" TEXT;
ALTER TABLE "Expense" ADD COLUMN "coversAiUsage" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Expense_vendor_month_idx" ON "Expense"("vendor", "month");
ALTER TABLE "RecurringExpense" ADD COLUMN "vendor" TEXT;
ALTER TABLE "RecurringExpense" ADD COLUMN "coversAiUsage" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "Founder" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Founder_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Founder_deletedAt_idx" ON "Founder"("deletedAt");

CREATE TABLE "FounderContribution" (
    "id" TEXT NOT NULL,
    "founderId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'TJS',
    "exchangeRate" DECIMAL(65,30),
    "date" TEXT NOT NULL,
    "month" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "requestKey" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FounderContribution_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FounderContribution_requestKey_key" ON "FounderContribution"("requestKey");
CREATE INDEX "FounderContribution_month_idx" ON "FounderContribution"("month");
CREATE INDEX "FounderContribution_founderId_month_idx" ON "FounderContribution"("founderId", "month");
ALTER TABLE "FounderContribution" ADD CONSTRAINT "FounderContribution_founderId_fkey" FOREIGN KEY ("founderId") REFERENCES "Founder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Учредители, названные владельцем 14.11.2026. Список правится в Деньги → Учредители.
INSERT INTO "Founder" ("id", "name", "sortOrder", "updatedAt") VALUES
    ('7b1c2f40-0001-4e6a-9f00-17112026f001', 'Баходур', 1, CURRENT_TIMESTAMP),
    ('7b1c2f40-0002-4e6a-9f00-17112026f002', 'Илхом', 2, CURRENT_TIMESTAMP),
    ('7b1c2f40-0003-4e6a-9f00-17112026f003', 'Мирсаид', 3, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
