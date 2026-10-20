-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "lastAgentId" TEXT,
ADD COLUMN     "reactivationOfferedAt" TIMESTAMP(3),
ADD COLUMN     "reactivationOfferedToAgentId" TEXT;

-- CreateIndex
CREATE INDEX "Client_reactivationOfferedToAgentId_idx" ON "Client"("reactivationOfferedToAgentId");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_lastAgentId_fkey" FOREIGN KEY ("lastAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_reactivationOfferedToAgentId_fkey" FOREIGN KEY ("reactivationOfferedToAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
