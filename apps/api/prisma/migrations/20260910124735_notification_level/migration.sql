-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "level" TEXT NOT NULL DEFAULT 'NORMAL';

-- CreateIndex
CREATE INDEX "Notification_agentId_level_read_idx" ON "Notification"("agentId", "level", "read");
