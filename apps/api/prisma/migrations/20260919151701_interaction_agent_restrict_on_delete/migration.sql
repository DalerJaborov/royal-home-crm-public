-- DropForeignKey
ALTER TABLE "Interaction" DROP CONSTRAINT "Interaction_agentId_fkey";

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
