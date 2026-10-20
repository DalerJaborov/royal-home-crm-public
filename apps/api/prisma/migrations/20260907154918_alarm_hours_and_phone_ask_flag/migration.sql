-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "offCrmAlarmNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "phoneAskFlaggedAt" TIMESTAMP(3),
ADD COLUMN     "phoneAskFlaggedByAgentId" TEXT;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "alarmHoursEnd" TEXT NOT NULL DEFAULT '14:45',
ADD COLUMN     "alarmHoursStart" TEXT NOT NULL DEFAULT '09:50';
