-- DropForeignKey
ALTER TABLE "Interaction" DROP CONSTRAINT "Interaction_agentId_fkey";

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "agentAttentionRequestedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Client_assignedAgentId_agentAttentionRequestedAt_idx" ON "Client"("assignedAgentId", "agentAttentionRequestedAt");

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
