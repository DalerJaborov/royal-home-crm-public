-- AlterEnum
ALTER TYPE "PropertyStage" ADD VALUE 'SHELL';

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "kpi" INTEGER;

-- AlterTable
ALTER TABLE "Interaction" ADD COLUMN     "completedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "kpiMinThreshold" INTEGER NOT NULL DEFAULT 70,
ADD COLUMN     "leadDistributionStrategy" TEXT NOT NULL DEFAULT 'fair',
ADD COLUMN     "offHoursMessage" TEXT NOT NULL DEFAULT 'Спасибо за обращение! Сейчас наши агенты не на связи — оставьте, пожалуйста, ваш номер телефона, и мы свяжемся с вами в рабочее время.',
ADD COLUMN     "workHoursEnd" TEXT NOT NULL DEFAULT '18:00',
ADD COLUMN     "workHoursStart" TEXT NOT NULL DEFAULT '09:30';

-- CreateTable
CREATE TABLE "KpiDailyScore" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "score" INTEGER NOT NULL,
    "breakdown" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KpiDailyScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KpiDailyScore_agentId_idx" ON "KpiDailyScore"("agentId");

-- CreateIndex
CREATE INDEX "KpiDailyScore_date_idx" ON "KpiDailyScore"("date");

-- CreateIndex
CREATE UNIQUE INDEX "KpiDailyScore_agentId_date_key" ON "KpiDailyScore"("agentId", "date");

-- AddForeignKey
ALTER TABLE "KpiDailyScore" ADD CONSTRAINT "KpiDailyScore_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
