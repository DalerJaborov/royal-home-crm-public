-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "intakeAgentId" TEXT;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_intakeAgentId_fkey" FOREIGN KEY ("intakeAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
