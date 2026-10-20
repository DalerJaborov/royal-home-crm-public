-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "propertySummaryAfterHours" INTEGER NOT NULL DEFAULT 36,
ADD COLUMN     "propertySummaryWindowEnd" TEXT NOT NULL DEFAULT '15:00',
ADD COLUMN     "propertySummaryWindowStart" TEXT NOT NULL DEFAULT '10:00',
ADD COLUMN     "summarySnoozeMaxCount" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "summarySnoozeMinutes" INTEGER NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE "PendingSummary" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snoozedUntil" TIMESTAMP(3),
    "snoozeCount" INTEGER NOT NULL DEFAULT 0,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingSummary_agentId_doneAt_idx" ON "PendingSummary"("agentId", "doneAt");

-- CreateIndex
CREATE UNIQUE INDEX "PendingSummary_kind_subjectId_key" ON "PendingSummary"("kind", "subjectId");

-- AddForeignKey
ALTER TABLE "PendingSummary" ADD CONSTRAINT "PendingSummary_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

