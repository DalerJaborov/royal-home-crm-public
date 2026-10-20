-- Месячный отчёт директору и админу (примечание владельца от 30.07). Цифры хранятся
-- снапшотом: отчёт за прошлый месяц не должен меняться от правок в текущей базе.
CREATE TABLE "MonthlyReport" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "metrics" JSONB NOT NULL,
    "notes" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MonthlyReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MonthlyReport_periodStart_key" ON "MonthlyReport"("periodStart");
CREATE INDEX "MonthlyReport_periodStart_idx" ON "MonthlyReport"("periodStart");

ALTER TABLE "MonthlyReport" ADD CONSTRAINT "MonthlyReport_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
