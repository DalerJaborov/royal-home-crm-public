-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "frozenAt" TIMESTAMP(3),
ADD COLUMN     "frozenById" TEXT,
ADD COLUMN     "frozenReason" TEXT,
ADD COLUMN     "leadsPausedEndedAt" TIMESTAMP(3),
ADD COLUMN     "leadsPausedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "agentPauseCooldownHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "agentPauseMaxHours" INTEGER NOT NULL DEFAULT 48;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_frozenById_fkey" FOREIGN KEY ("frozenById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
