-- Разбор проблемных мест: еженедельный и ежемесячный отчёт (решение владельца 11.08.2026).
--
-- ВНИМАНИЕ ТЕМ, КТО БУДЕТ ПРАВИТЬ ЭТУ МИГРАЦИЮ ЗАНОВО: `prisma migrate diff` в этом
-- репозитории всегда предлагает удалить триграммные индексы поиска
-- (Client_fullName_trgm_idx, Property_address_trgm_idx, Property_title_trgm_idx).
-- Они заведены сырой миграцией и в datamodel отсутствуют по определению — их удаление
-- молча убивает поиск по клиентам и объектам. Из вывода diff эти три DROP INDEX
-- вычищены вручную.

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "problemReportMonthlyEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "problemReportWeeklyEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ProblemReport" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "metrics" JSONB NOT NULL,
    "notes" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProblemReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProblemReport_period_periodStart_idx" ON "ProblemReport"("period", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "ProblemReport_period_periodStart_key" ON "ProblemReport"("period", "periodStart");

-- AddForeignKey
ALTER TABLE "ProblemReport" ADD CONSTRAINT "ProblemReport_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
